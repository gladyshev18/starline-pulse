import { and, asc, desc, eq, gt, gte, isNotNull, lte } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { deviceEvents, engineSessions, trips, vehicleSnapshots } from '../../db/schema'
import { armedMinutesBetween } from '../../metrics/engine'
import { capImplausibleDistance, sessionOdometerSpan } from '../../metrics/odometer'
import { tripFuelUsed } from '../../shared/fuel'
import { ENGINE_STARTED, ENGINE_STOPPED, HANDBRAKE_RELEASED, IGNITION_OFF, IGNITION_ON } from '../../shared/starline-events'
import { config } from '../config'
import { getSlnet, starlineRequest } from './auth'

type EngineSession = typeof engineSessions.$inferSelect

const EVENTS_PAGE_SIZE = 100
// Одной страницы хватает на сутки с запасом: за август самый плотный день дал
// 80 событий. Предел на всякий случай, чтобы первый заход не выгреб всю историю
// разом и не съел дневной лимит запросов.
const EVENTS_MAX_PAGES = 8
const EVENTS_BACKFILL_MS = 3 * 24 * 60 * 60_000

export interface StarLineEvent {
  type: number
  groupId: number
  timestamp: number
}

// Выборка идёт вперёд от `ts`, страницами. Ни `from`/`to`, ни query-string
// сервер не понимает: v1 молча отдаёт пустой массив на любые параметры, v2
// требует `start` и не принимает его ни в каком виде. Работает только это.
export async function fetchEventsPage(database: Database, since: Date) {
  const slnet = await getSlnet(database)
  const response = await starlineRequest(
    database,
    `https://developer.starline.ru/json/v3/device/${encodeURIComponent(config.starlineDeviceId)}/events`,
    {
      method: 'POST',
      headers: { cookie: `slnet=${slnet}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ts: Math.floor(since.getTime() / 1000), limit: EVENTS_PAGE_SIZE })
    }
  )
  const payload = await response.json() as { code?: number, codestring?: string, events?: StarLineEvent[] }
  if (payload.code !== 200) throw new Error(`StarLine events: ${payload.codestring || payload.code}`)
  return payload.events ?? []
}

export async function storeEvents(database: Database, vehicleId: number, events: StarLineEvent[]) {
  if (!events.length) return 0
  const rows = events
    .filter(item => Number.isFinite(item.timestamp) && Number.isFinite(item.type))
    .map(item => ({
      vehicleId,
      type: Number(item.type),
      groupId: Number.isFinite(item.groupId) ? Number(item.groupId) : null,
      ts: new Date(item.timestamp * 1000)
    }))
  if (!rows.length) return 0
  const stored = await database.insert(deviceEvents).values(rows).onConflictDoNothing().returning({ id: deviceEvents.id })
  return stored.length
}

// Страница берётся через параметр, чтобы разбор постраничной выборки можно было
// проверить, не поднимая авторизацию StarLine.
export type EventPageLoader = (since: Date) => Promise<StarLineEvent[]>

export async function syncEvents(
  database: Database,
  vehicleId: number,
  loadPage: EventPageLoader = since => fetchEventsPage(database, since),
  maxPages = EVENTS_MAX_PAGES
) {
  const latest = await database.query.deviceEvents.findFirst({
    where: eq(deviceEvents.vehicleId, vehicleId),
    orderBy: desc(deviceEvents.ts)
  })
  let cursor = latest ? new Date(latest.ts.getTime() + 1000) : new Date(Date.now() - EVENTS_BACKFILL_MS)
  let stored = 0
  for (let page = 0; page < maxPages; page++) {
    const events = await loadPage(cursor)
    if (!events.length) break
    stored += await storeEvents(database, vehicleId, events)
    const last = Math.max(...events.map(item => item.timestamp))
    const next = new Date(last * 1000 + 1000)
    // Неполная страница не означает, что события кончились: сервер режет выдачу
    // и по своим внутренним окнам тоже. Признак конца — пустой ответ или
    // курсор, который перестал двигаться, иначе выборка останавливается на
    // первом же тихом дне и до сегодняшних событий не доходит.
    if (next <= cursor) break
    cursor = next
  }
  return stored
}

export interface IgnitionSpan {
  startedAt: Date
  endedAt: Date
}

// Интервал работы двигателя по журналу сигнализации. Пара «зажигание включено —
// отключено» первична; если включения не видно, годится и «двигатель запущен»,
// потому что в журнале встречаются циклы, где до нас доехала только половина
// пары. Незакрытый интервал не возвращается: у него нет конца, а поездка без
// конца ничего не исправит.
export async function ignitionSpans(database: Database, vehicleId: number, since?: Date) {
  const rows = await database.select().from(deviceEvents).where(and(
    eq(deviceEvents.vehicleId, vehicleId),
    since ? gte(deviceEvents.ts, since) : undefined
  )).orderBy(asc(deviceEvents.ts))

  const spans: Array<{ startedAt: Date, endedAt: Date | null }> = []
  for (const row of rows) {
    const opens = row.type === IGNITION_ON || row.type === ENGINE_STARTED
    const closes = row.type === IGNITION_OFF || row.type === ENGINE_STOPPED
    if (opens) {
      const last = spans.at(-1)
      // Два «запущен» подряд без остановки между ними — это одно и то же
      // событие, доехавшее двумя кодами, а не два запуска.
      if (last && last.endedAt == null) continue
      spans.push({ startedAt: row.ts, endedAt: null })
      continue
    }
    if (!closes) continue
    const open = spans.at(-1)
    if (open && open.endedAt == null) open.endedAt = row.ts
  }
  return spans.filter((item): item is IgnitionSpan => item.endedAt != null && item.endedAt > item.startedAt)
}

function overlap(span: IgnitionSpan, session: { startedAt: Date, endedAt: Date | null }) {
  if (!session.endedAt) return 0
  const from = Math.max(span.startedAt.getTime(), session.startedAt.getTime())
  const to = Math.min(span.endedAt.getTime(), session.endedAt.getTime())
  return Math.max(0, to - from)
}

// Сессия и интервал описывают один и тот же запуск, если пересечение покрывает
// бо́льшую часть сессии.
//
// Мерить долю от короткого из двух нельзя, хотя и напрашивается: короткий
// интервал, целиком лежащий внутри длинной сессии, набирает так почти единицу и
// схлопывает её до себя. На боевых данных это отобрало у поездки 14 августа
// тридцать две минуты из сорока одной. Такое бывает, когда опрос пропустил
// выключение зажигания посередине и склеил два запуска в одну сессию, — но
// разрезать её надвое по одному пересечению нельзя, а испортить легко, поэтому
// сессия без подходящего интервала остаётся как есть.
//
// Сопоставлять по близости стартов нельзя тем более: «ближайший интервал в
// пределах получаса» приписал стодесятиминутной поездке семиминутный и выдал
// 842 км/ч.
const MIN_SESSION_COVERAGE = 0.5

function matches(span: IgnitionSpan, session: { startedAt: Date, endedAt: Date | null }) {
  if (!session.endedAt) return 0
  const shared = overlap(span, session)
  if (!shared) return 0
  const sessionLength = Math.max(1, session.endedAt.getTime() - session.startedAt.getTime())
  return shared / sessionLength >= MIN_SESSION_COVERAGE ? shared : 0
}

export interface BoundaryReport {
  corrected: Array<{ sessionId: number, startedAt: Date, endedAt: Date, shiftedStartSeconds: number }>
  created: Array<{ sessionId: number, startedAt: Date, endedAt: Date, distance: number | null }>
  // Записи, оказавшиеся прогревом: одометр за них так и не сдвинулся.
  removed: Array<{ tripId: number, startedAt: Date }>
}

// Когда машина тронулась. «Ручник опущен» — единственная точная отметка начала
// движения: на боевых данных она есть у 63 поездок из 65 и ни у одного из девяти
// прогревов на автозапуске, то есть не срабатывает там, где машина заведомо
// стояла. Обратной отметки нет — «ручник поднят» пришёл 4 раза против 116
// «опущен», потому что приехав глушат двигатель кнопкой и ручник встаёт уже
// после того, как блоку нечего передавать.
export async function departureWithin(database: Database, vehicleId: number, from: Date, to: Date) {
  const event = await database.query.deviceEvents.findFirst({
    columns: { ts: true },
    where: and(
      eq(deviceEvents.vehicleId, vehicleId),
      eq(deviceEvents.type, HANDBRAKE_RELEASED),
      gte(deviceEvents.ts, from),
      lte(deviceEvents.ts, to)
    ),
    orderBy: asc(deviceEvents.ts)
  })
  return event?.ts ?? null
}

// Часы, за которые сессия могла ехать. От опущенного ручника, если он известен,
// иначе от запуска двигателя — тогда получается верхняя оценка, и предел выйдет
// мягче. Мягче — это правильно: сомнение толкуется в пользу записи.
function movingHoursOf(session: { startedAt: Date, endedAt: Date | null }, departedAt: Date | null) {
  if (!session.endedAt) return null
  const from = departedAt && departedAt >= session.startedAt && departedAt <= session.endedAt
    ? departedAt
    : session.startedAt
  return Math.max(0, session.endedAt.getTime() - from.getTime()) / 3_600_000
}

async function snapshotAround(database: Database, vehicleId: number, at: Date, direction: 'before' | 'after') {
  return await database.query.vehicleSnapshots.findFirst({
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicleId),
      isNotNull(vehicleSnapshots.fuel),
      direction === 'before' ? lte(vehicleSnapshots.ts, at) : gte(vehicleSnapshots.ts, at)
    ),
    orderBy: direction === 'before' ? desc(vehicleSnapshots.ts) : asc(vehicleSnapshots.ts)
  })
}

// Поездка привязана к своей сессии равенством `started_at`, поэтому сдвигать
// границы можно только вместе с ней — иначе поездка осиротеет и перестанет
// закрываться.
async function moveTripWithSession(database: Database, session: EngineSession, startedAt: Date, endedAt: Date) {
  const trip = await database.query.trips.findFirst({
    where: and(eq(trips.vehicleId, session.vehicleId), eq(trips.startedAt, session.startedAt))
  })
  if (!trip) return
  const armedMinutes = await armedMinutesBetween(database, session.vehicleId, startedAt, endedAt)
  await database.update(trips).set({
    startedAt,
    endedAt: trip.isOpen ? trip.endedAt : endedAt,
    armedMinutes
  }).where(eq(trips.id, trip.id))
}

// Границы сессий берутся из журнала сигнализации, а не из опроса.
//
// Опрос видит машину раз в полминуты на ходу и раз в полчаса на стоянке,
// поэтому старт сессии в снапшотах опаздывает в среднем на 73 секунды, а если
// запуск целиком уместился между двумя опросами — сессии не появляется вовсе.
// За август таких пропусков набралось 27, от двух минут до полутора часов, и
// среди них поездка, из-за которой две записи налезали друг на друга.
//
// Пробег остаётся за одометром: в журнале его нет.
export async function applyEventBoundaries(database: Database, vehicleId: number, since?: Date) {
  const report: BoundaryReport = { corrected: [], created: [], removed: [] }
  const spans = await ignitionSpans(database, vehicleId, since)
  if (!spans.length) return report

  const earliest = spans[0]!.startedAt
  const sessions = await database.select().from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false),
    gte(engineSessions.endedAt, earliest)
  )).orderBy(asc(engineSessions.startedAt))

  // Сначала только время — все границы разом, без единого километра.
  //
  // Пробег нельзя считать здесь же: отрезок сессии кончается там, где начинается
  // следующая, а следующей в этот момент ещё может не существовать. На боевых
  // данных так и вышло — поездка 28 августа разделилась надвое, и обе половины
  // успели записать себе все 94 км, потому что первую пересчитали до появления
  // второй.
  const taken = new Set<number>()
  for (const span of spans) {
    let best: EngineSession | null = null
    let bestOverlap = 0
    for (const session of sessions) {
      if (taken.has(session.id)) continue
      const score = matches(span, session)
      if (score > bestOverlap) { best = session; bestOverlap = score }
    }

    if (best) {
      taken.add(best.id)
      if (best.startedAt.getTime() === span.startedAt.getTime() && best.endedAt?.getTime() === span.endedAt.getTime()) continue
      const shifted = Math.round((best.startedAt.getTime() - span.startedAt.getTime()) / 1000)
      await moveTripWithSession(database, best, span.startedAt, span.endedAt)
      await database.update(engineSessions).set({
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        durationMinutes: (span.endedAt.getTime() - span.startedAt.getTime()) / 60_000
      }).where(eq(engineSessions.id, best.id))
      best.startedAt = span.startedAt
      best.endedAt = span.endedAt
      report.corrected.push({ sessionId: best.id, startedAt: span.startedAt, endedAt: span.endedAt, shiftedStartSeconds: shifted })
      continue
    }

    // Ни одна сессия не описывает этот запуск: опрос его проспал целиком.
    const fuelStart = await snapshotAround(database, vehicleId, span.startedAt, 'before')
    const fuelEnd = await snapshotAround(database, vehicleId, span.endedAt, 'after')
    const [created] = await database.insert(engineSessions).values({
      vehicleId,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      fuelStart: fuelStart?.fuel ?? null,
      fuelEnd: fuelEnd?.fuel ?? null,
      durationMinutes: (span.endedAt.getTime() - span.startedAt.getTime()) / 60_000,
      isOpen: false
    }).returning()
    if (!created) continue
    sessions.push(created)
    report.created.push({ sessionId: created.id, startedAt: span.startedAt, endedAt: span.endedAt, distance: null })
  }
  // Теперь километры — по всему окну, а не только по тронутым записям.
  //
  // Отрезок сессии кончается на запуске следующей, поэтому появление новой
  // записи меняет и соседнюю слева. И проход обязан идти даже когда границы
  // никто не двигал: если предыдущий заход упал между двумя фазами, только это
  // и вылечит оставшиеся половинчатые записи. Пишется всё равно лишь то, что
  // разошлось, так что повторный проход ничего не стоит.
  const window = await database.select().from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false),
    gte(engineSessions.endedAt, earliest)
  )).orderBy(asc(engineSessions.startedAt))

  // Отрезки считаются все сразу, а не по одному: правило «машина не могла
  // проехать больше, чем успевает» смотрит на соседа слева, и решить это на
  // одной записи нельзя.
  const departures = new Map<number, Date | null>()
  for (const session of window) {
    departures.set(session.id, await departureWithin(database, vehicleId, session.startedAt, session.endedAt!))
  }
  const raw: Array<Awaited<ReturnType<typeof sessionOdometerSpan>>> = []
  for (const session of window) raw.push(await sessionOdometerSpan(database, session))
  const capped = capImplausibleDistance(window.map((session, index) => ({
    mileageStart: raw[index]!.mileageStart,
    mileageEnd: raw[index]!.mileageEnd,
    movingHours: movingHoursOf(session, departures.get(session.id) ?? null)
  })))

  for (const [index, session] of window.entries()) {
    const span = capped[index]!
    const odometer = {
      mileageStart: span.mileageStart,
      mileageEnd: span.mileageEnd,
      distance: span.mileageStart != null && span.mileageEnd != null && span.mileageEnd >= span.mileageStart
        ? span.mileageEnd - span.mileageStart
        : null
    }
    const entry = report.created.find(item => item.sessionId === session.id)
    if (entry) entry.distance = odometer.distance
    if (odometer.distance == null) continue
    if (session.mileageStart !== odometer.mileageStart || session.mileageEnd !== odometer.mileageEnd) {
      await database.update(engineSessions).set({
        mileageStart: odometer.mileageStart,
        mileageEnd: odometer.mileageEnd,
        distance: odometer.distance,
        isStationary: odometer.distance === 0
      }).where(eq(engineSessions.id, session.id))
    }

    const trip = await database.query.trips.findFirst({
      where: and(eq(trips.vehicleId, vehicleId), eq(trips.startedAt, session.startedAt))
    })
    if (trip && !trip.isOpen) {
      // Машина никуда не уехала — это прогрев, а не поездка, и в журнале ей не
      // место. Проверка стоит здесь, а не в момент закрытия: одометр досылает
      // остаток минутами позже, и поездка, у которой в тот момент был ноль,
      // запросто оказывается настоящей дорогой. К этому проходу окно досылки
      // уже закрыто. Комментарий писали руками, и запись с ним остаётся.
      if (odometer.distance === 0 && !trip.comment) {
        await database.delete(trips).where(eq(trips.id, trip.id))
        report.removed.push({ tripId: trip.id, startedAt: session.startedAt })
        continue
      }
      const departedAt = departures.get(session.id) ?? null
      const sameOdometer = trip.mileageStart === odometer.mileageStart && trip.mileageEnd === odometer.mileageEnd
      const sameDeparture = trip.departedAt?.getTime() === departedAt?.getTime()
      if (!sameOdometer || !sameDeparture) {
        await database.update(trips).set({
          mileageStart: odometer.mileageStart,
          mileageEnd: odometer.mileageEnd,
          distance: odometer.distance,
          departedAt
        }).where(eq(trips.id, trip.id))
      }
      continue
    }
    // Проехала, а поездки нет — значит запуск проспали, и дорогу надо записать.
    // Стояла — это прогрев, сессии достаточно.
    if (!trip && odometer.distance > 0) {
      const covered = await database.query.trips.findFirst({
        where: and(
          eq(trips.vehicleId, vehicleId),
          lte(trips.startedAt, session.endedAt!),
          gt(trips.endedAt, session.startedAt)
        )
      })
      if (covered) continue
      await database.insert(trips).values({
        vehicleId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        departedAt: departures.get(session.id) ?? null,
        mileageStart: odometer.mileageStart,
        mileageEnd: odometer.mileageEnd,
        distance: odometer.distance,
        fuelStart: session.fuelStart,
        fuelEnd: session.fuelEnd,
        fuelUsed: tripFuelUsed(session.fuelStart, session.fuelEnd),
        armedMinutes: await armedMinutesBetween(database, vehicleId, session.startedAt, session.endedAt!),
        isOpen: false
      })
    }
  }
  return report
}
