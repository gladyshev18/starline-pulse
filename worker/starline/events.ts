import { and, asc, desc, eq, gt, gte, isNotNull, lte } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { deviceEvents, engineSessions, trips, vehicleSnapshots } from '../../db/schema'
import { armedMinutesBetween } from '../../metrics/engine'
import { sessionOdometerSpan } from '../../metrics/odometer'
import { tripFuelUsed } from '../../shared/fuel'
import { ENGINE_STARTED, ENGINE_STOPPED, IGNITION_OFF, IGNITION_ON } from '../../shared/starline-events'
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

// Сессия и интервал описывают один и тот же запуск, если они пересекаются во
// времени и пересечение занимает большую часть более короткого из них.
//
// Сопоставлять по близости стартов нельзя, проверено на боевых данных: в день,
// когда машину заводили семь раз за час, «ближайший интервал в пределах
// получаса» приписал стодесятиминутной поездке семиминутный интервал и выдал
// 842 км/ч. Пересечение таких пар не допускает.
const MIN_OVERLAP_SHARE = 0.5

function matches(span: IgnitionSpan, session: { startedAt: Date, endedAt: Date | null }) {
  if (!session.endedAt) return 0
  const shared = overlap(span, session)
  if (!shared) return 0
  const spanLength = span.endedAt.getTime() - span.startedAt.getTime()
  const sessionLength = session.endedAt.getTime() - session.startedAt.getTime()
  const shortest = Math.max(1, Math.min(spanLength, sessionLength))
  return shared / shortest >= MIN_OVERLAP_SHARE ? shared : 0
}

export interface BoundaryReport {
  corrected: Array<{ sessionId: number, startedAt: Date, endedAt: Date, shiftedStartSeconds: number }>
  created: Array<{ startedAt: Date, endedAt: Date, distance: number | null }>
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
  const report: BoundaryReport = { corrected: [], created: [] }
  const spans = await ignitionSpans(database, vehicleId, since)
  if (!spans.length) return report

  const earliest = spans[0]!.startedAt
  const sessions = await database.select().from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false),
    gte(engineSessions.endedAt, earliest)
  )).orderBy(asc(engineSessions.startedAt))

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
      const shifted = Math.round((best.startedAt.getTime() - span.startedAt.getTime()) / 1000)
      const sameStart = best.startedAt.getTime() === span.startedAt.getTime()
      const sameEnd = best.endedAt?.getTime() === span.endedAt.getTime()
      if (sameStart && sameEnd) continue
      await moveTripWithSession(database, best, span.startedAt, span.endedAt)
      await database.update(engineSessions).set({
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        durationMinutes: (span.endedAt.getTime() - span.startedAt.getTime()) / 60_000
      }).where(eq(engineSessions.id, best.id))
      best.startedAt = span.startedAt
      best.endedAt = span.endedAt
      const restated = await sessionOdometerSpan(database, best)
      if (restated.distance != null) {
        await database.update(engineSessions).set({
          mileageStart: restated.mileageStart,
          mileageEnd: restated.mileageEnd,
          distance: restated.distance,
          isStationary: restated.distance === 0
        }).where(eq(engineSessions.id, best.id))
      }
      report.corrected.push({ sessionId: best.id, startedAt: span.startedAt, endedAt: span.endedAt, shiftedStartSeconds: shifted })
      continue
    }

    // Ни одна сессия не описывает этот запуск: опрос его проспал целиком.
    const fuelStart = await snapshotAround(database, vehicleId, span.startedAt, 'before')
    const fuelEnd = await snapshotAround(database, vehicleId, span.endedAt, 'after')
    const window = { vehicleId, startedAt: span.startedAt, endedAt: span.endedAt }
    const odometer = await sessionOdometerSpan(database, window)
    const [created] = await database.insert(engineSessions).values({
      vehicleId,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      mileageStart: odometer.mileageStart,
      mileageEnd: odometer.mileageEnd,
      distance: odometer.distance,
      fuelStart: fuelStart?.fuel ?? null,
      fuelEnd: fuelEnd?.fuel ?? null,
      durationMinutes: (span.endedAt.getTime() - span.startedAt.getTime()) / 60_000,
      isStationary: odometer.distance == null ? null : odometer.distance === 0,
      isOpen: false
    }).returning()
    if (created) sessions.push(created)
    report.created.push({ startedAt: span.startedAt, endedAt: span.endedAt, distance: odometer.distance })

    // Проехала — значит это поездка, и в журнале ей место. Стояла — это прогрев,
    // сессии достаточно.
    if (created && (odometer.distance ?? 0) > 0) {
      const covered = await database.query.trips.findFirst({
        where: and(
          eq(trips.vehicleId, vehicleId),
          lte(trips.startedAt, span.endedAt),
          gt(trips.endedAt, span.startedAt)
        )
      })
      if (!covered) {
        await database.insert(trips).values({
          vehicleId,
          startedAt: span.startedAt,
          endedAt: span.endedAt,
          mileageStart: odometer.mileageStart,
          mileageEnd: odometer.mileageEnd,
          distance: odometer.distance,
          fuelStart: fuelStart?.fuel ?? null,
          fuelEnd: fuelEnd?.fuel ?? null,
          fuelUsed: tripFuelUsed(fuelStart?.fuel ?? null, fuelEnd?.fuel ?? null),
          armedMinutes: await armedMinutesBetween(database, vehicleId, span.startedAt, span.endedAt),
          isOpen: false
        })
      }
    }
  }
  return report
}
