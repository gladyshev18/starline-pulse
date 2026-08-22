import { and, asc, desc, eq, gt, gte, isNotNull, lte, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { armedMinutesBetween } from '../../metrics/engine'
import { engineSessions, trips, vehicleSnapshots } from '../../db/schema'
import { tripFuelUsed } from '../../shared/fuel'

type Trip = typeof trips.$inferSelect
type EngineSession = typeof engineSessions.$inferSelect

// История писалась кодом, который принимал досылку одометра по стоящей машине за
// начало поездки. Это разовый проход по уже накопленным записям: он делает с
// ними то же, что теперь делает воркер на живом опросе, и ничего не выдумывает
// сверх того, что есть в снапшотах.

export interface RecomputeReport {
  sessionsExtended: Array<{ id: number, distance: number, wasStationary: boolean }>
  tripsReanchored: Array<{ id: number, sessionId: number, startedAt: Date }>
  tripsMerged: Array<{ id: number, intoId: number, distance: number }>
  phantomsLeft: Array<{ id: number, startedAt: Date, distance: number | null }>
  tripsEmptied: Array<{ id: number, startedAt: Date, kept: boolean }>
  tripsCreated: Array<{ sessionId: number, startedAt: Date, distance: number }>
  tripsRewritten: Array<{ id: number, changes: Record<string, { from: unknown, to: unknown }> }>
  // Ни один километр не должен ни появиться, ни исчезнуть: пересчёт только
  // перекладывает пробег между записями. Одометр — независимый свидетель, и
  // расхождение с ним значит, что в разборе есть ошибка.
  distanceBefore: number
  distanceAfter: number
  odometerSpan: number | null
}

function sameMileage(left: number | null, right: number | null) {
  return left != null && right != null && Math.abs(left - right) < 0.01
}

function sessionMileageEdge(session: EngineSession) {
  return session.mileageEnd ?? session.mileageStart
}

// Двигатель работал внутри окна — по любому из двух независимых признаков.
// Счётчику моточасов веры больше: он не может пропустить запуск, тогда как
// зажигание видно только в тот момент, когда пришёлся опрос.
async function engineRanBetween(database: Database, vehicleId: number, start: Date, end: Date) {
  const running = await database.query.vehicleSnapshots.findFirst({
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicleId),
      eq(vehicleSnapshots.ignition, true),
      gte(vehicleSnapshots.ts, start),
      lte(vehicleSnapshots.ts, end)
    )
  })
  if (running) return true

  const motor = await database.select({ value: vehicleSnapshots.motorMinutes }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    isNotNull(vehicleSnapshots.motorMinutes),
    gte(vehicleSnapshots.ts, start),
    lte(vehicleSnapshots.ts, end)
  )).orderBy(asc(vehicleSnapshots.ts))
  // Одного показания мало, чтобы утверждать, что двигатель молчал: сравнивать
  // не с чем. Такое окно остаётся нетронутым.
  if (motor.length < 2) return true
  return Number(motor.at(-1)!.value) > Number(motor[0]!.value)
}

// Пробег, досланный одометром уже после того, как сессия закрылась.
//
// Отделить его от километров следующей поездки по флагу зажигания в снапшоте
// нельзя: досылка запаздывает на минуты и запросто приезжает в том опросе, где
// машину уже успели завести снова. Зато у самого показания есть своё время —
// `mileage_ts`, — и оно честно говорит, на какой момент этот пробег снят. Всё,
// что снято до следующего запуска двигателя, принадлежит закрывшейся сессии,
// кто бы это ни привёз.
async function lateMileageFor(database: Database, session: EngineSession, nextStartedAt: Date | null) {
  if (!session.endedAt || session.mileageStart == null) return null
  // Счётчик моточасов досчитывает последнюю минуту уже в том опросе, который
  // застаёт зажигание выключенным, поэтому за итог сессии берётся именно это
  // показание. Сравнивать с последним показанием до остановки нельзя: рост на
  // ту самую минуту оборвал бы просмотр на первом же шаге, до всякой досылки.
  const settled = await database.query.vehicleSnapshots.findFirst({
    columns: { motorMinutes: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, session.vehicleId),
      isNotNull(vehicleSnapshots.motorMinutes),
      gte(vehicleSnapshots.ts, session.endedAt)
    ),
    orderBy: asc(vehicleSnapshots.ts)
  })

  const following = await database.select({
    ts: vehicleSnapshots.ts,
    mileage: vehicleSnapshots.mileage,
    mileageTs: vehicleSnapshots.mileageTs,
    motorMinutes: vehicleSnapshots.motorMinutes
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, session.vehicleId),
    gt(vehicleSnapshots.ts, session.endedAt)
  )).orderBy(asc(vehicleSnapshots.ts))

  let best = session.mileageEnd
  for (const row of following) {
    // Счётчик моточасов пошёл дальше того, на чём остановилась сессия: машина
    // поехала снова, и дальше смотреть незачем — даже если поездку не завели
    // ни в одной сессии.
    if (settled?.motorMinutes != null && row.motorMinutes != null && row.motorMinutes > settled.motorMinutes) break
    if (row.mileage == null) continue
    const readAt = row.mileageTs ?? row.ts
    if (nextStartedAt && readAt > nextStartedAt) continue
    if (best == null || row.mileage > best) best = row.mileage
  }
  if (best == null || (session.mileageEnd != null && best <= session.mileageEnd)) return null
  return best
}

export async function recomputeTrips(database: Database, options: { apply: boolean }): Promise<RecomputeReport> {
  const report: RecomputeReport = {
    sessionsExtended: [], tripsReanchored: [], tripsMerged: [], phantomsLeft: [], tripsEmptied: [],
    tripsCreated: [], tripsRewritten: [],
    distanceBefore: 0, distanceAfter: 0, odometerSpan: null
  }

  const [span] = await database.select({
    low: sql<number | null>`min(${vehicleSnapshots.mileage})`,
    high: sql<number | null>`max(${vehicleSnapshots.mileage})`
  }).from(vehicleSnapshots).where(isNotNull(vehicleSnapshots.mileage))
  report.odometerSpan = span?.low != null && span.high != null ? Number(span.high) - Number(span.low) : null

  // 1. Сессии забирают свою досылку. От этого зависит is_stationary, а по нему
  //    считается и счёт за холостой ход, и сама ставка литров в час.
  const sessions = await database.select().from(engineSessions)
    .where(eq(engineSessions.isOpen, false)).orderBy(asc(engineSessions.startedAt))
  for (const [index, session] of sessions.entries()) {
    const nextStartedAt = sessions.slice(index + 1).find(item => item.vehicleId === session.vehicleId)?.startedAt ?? null
    const mileageEnd = await lateMileageFor(database, session, nextStartedAt)
    if (mileageEnd == null || session.mileageStart == null) continue
    const distance = mileageEnd - session.mileageStart
    if (distance < 0) continue
    report.sessionsExtended.push({ id: session.id, distance, wasStationary: session.isStationary === true })
    if (options.apply) {
      await database.update(engineSessions).set({
        mileageEnd, distance, isStationary: distance === 0
      }).where(eq(engineSessions.id, session.id))
    }
    session.mileageEnd = mileageEnd
    session.distance = distance
    session.isStationary = distance === 0
  }

  // 2. После расширения таблица сессий — самая полная запись о том, когда
  //    двигатель работал и сколько машина проехала. Поездки должны её зеркалить,
  //    поэтому дальше всё сводится к тому, чтобы у каждой сессии была ровно одна
  //    поездка, а у каждой поездки — её собственные границы.
  const closedTrips = await database.select().from(trips)
    .where(eq(trips.isOpen, false)).orderBy(asc(trips.startedAt))
  report.distanceBefore = closedTrips.reduce((sum, trip) => sum + (trip.distance ?? 0), 0)
  const removed = new Set<number>()

  // Поездка принадлежит сессии, если они пересекаются во времени. Совпадения
  // стартов здесь мало: поездки, заведённые по старому запасному пути,
  // начинаются на минуту-другую позже своей сессии.
  const overlaps = (trip: Trip, session: EngineSession) => trip.vehicleId === session.vehicleId
    && session.endedAt != null
    && trip.startedAt <= session.endedAt
    && (trip.endedAt ?? trip.startedAt) >= session.startedAt
  const sessionOf = (trip: Trip) => sessions.filter(item => overlaps(trip, item)).at(-1)

  for (const trip of closedTrips) {
    if (!trip.endedAt || removed.has(trip.id)) continue
    if (await engineRanBetween(database, trip.vehicleId, trip.startedAt, trip.endedAt)) continue

    // Сессия, внутри чьего пробега лежат эти километры. После первого шага она
    // знает всю свою дорогу, включая досылку, поэтому вопрос сводится к тому,
    // чей это отрезок одометра.
    const owner = sessions.filter(item => item.vehicleId === trip.vehicleId
      && item.endedAt != null && item.endedAt <= trip.startedAt
      && item.mileageStart != null && item.mileageEnd != null
      && trip.mileageStart != null && trip.mileageEnd != null
      && item.mileageStart <= trip.mileageStart
      && item.mileageEnd >= trip.mileageEnd).at(-1)
    if (!owner) {
      report.phantomsLeft.push({ id: trip.id, startedAt: trip.startedAt, distance: trip.distance })
      continue
    }

    const existing = closedTrips.find(item => item.id !== trip.id && !removed.has(item.id) && overlaps(item, owner))
    if (!existing) {
      // У сессии не было своей поездки — эта запись ею и становится. Границы
      // проставит третий шаг, здесь достаточно перенести старт, по которому она
      // теперь находит свою сессию.
      report.tripsReanchored.push({ id: trip.id, sessionId: owner.id, startedAt: owner.startedAt })
      if (options.apply) {
        await database.update(trips).set({ startedAt: owner.startedAt, endedAt: owner.endedAt }).where(eq(trips.id, trip.id))
      }
      trip.startedAt = owner.startedAt
      trip.endedAt = owner.endedAt
      continue
    }

    // Поездка у сессии уже есть, а эта запись — лишь её досланный хвост. Сами
    // километры вернёт третий шаг, забрав их у сессии; здесь остаётся снять
    // дубль и не потерять ответ бота о том, кто был за рулём.
    report.tripsMerged.push({ id: trip.id, intoId: existing.id, distance: trip.distance ?? 0 })
    // Имя водителя переезжает вместе с километрами: бот спрашивал про фантом, а
    // ответ относится к той дороге, которая под ним скрывалась.
    if (!existing.driver && trip.driver) {
      existing.driver = trip.driver
      if (options.apply) await database.update(trips).set({ driver: trip.driver }).where(eq(trips.id, existing.id))
    }
    // Комментарий писал человек, и слить два текста в один без потерь нельзя.
    // Такая запись остаётся, обнулив свой вклад в километры.
    if (trip.comment) {
      report.tripsEmptied.push({ id: trip.id, startedAt: trip.startedAt, kept: true })
      if (options.apply) {
        await database.update(trips).set({ mileageEnd: trip.mileageStart, distance: 0, fuelUsed: 0 }).where(eq(trips.id, trip.id))
      }
      trip.mileageEnd = trip.mileageStart
      trip.distance = 0
      continue
    }
    if (options.apply) await database.delete(trips).where(eq(trips.id, trip.id))
    removed.add(trip.id)
  }

  // 2б. Сессия, которая проехала, но поездки так и не завела. Такое выходит,
  //     когда одометр за всю сессию не сказал ни слова, а досылку привёз опрос,
  //     где двигатель уже работал снова: тогда в момент роста пробега открывать
  //     было нечего. Дорога была, и в журнале ей место.
  for (const session of sessions) {
    if (!session.endedAt || !(session.distance! > 0)) continue
    if (closedTrips.some(trip => !removed.has(trip.id) && overlaps(trip, session))) continue
    report.tripsCreated.push({ sessionId: session.id, startedAt: session.startedAt, distance: session.distance! })
    const values = {
      vehicleId: session.vehicleId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      mileageStart: session.mileageStart,
      mileageEnd: session.mileageEnd,
      distance: session.distance,
      fuelStart: session.fuelStart,
      fuelEnd: session.fuelEnd,
      fuelUsed: tripFuelUsed(session.fuelStart, session.fuelEnd),
      armedMinutes: await armedMinutesBetween(database, session.vehicleId, session.startedAt, session.endedAt),
      isOpen: false
    }
    if (options.apply) {
      const [created] = await database.insert(trips).values(values).returning()
      if (created) closedTrips.push(created)
      continue
    }
    // Пробный прогон: запись нужна только чтобы километры сошлись в отчёте, в
    // базу она не попадёт. Отрицательный идентификатор отличает её от настоящей.
    closedTrips.push({
      ...values, id: -session.id, latStart: null, lonStart: null, latEnd: null, lonEnd: null,
      comment: null, driver: null
    })
  }

  // 3. Границы и производные величины. Поездка, у которой есть сессия, берёт
  //    время и одометр у неё: сессия открывается по зажиганию, а не по первому
  //    шевелению одометра, и закрывается тем же событием, а не тем опросом,
  //    который об этом узнал. Поездке без сессии — той, что целиком уместилась
  //    между двумя опросами, — верить больше нечему, и она остаётся как есть.
  for (const trip of closedTrips) {
    if (removed.has(trip.id) || !trip.endedAt) continue
    const session = sessionOf(trip)
    const startedAt = session?.startedAt ?? trip.startedAt
    const endedAt = session?.endedAt ?? trip.endedAt
    const mileageStart = session?.mileageStart ?? trip.mileageStart
    const mileageEnd = session?.mileageEnd ?? trip.mileageEnd
    const fuelStart = trip.fuelStart ?? session?.fuelStart ?? null
    const fuelEnd = trip.fuelEnd ?? session?.fuelEnd ?? null
    const distance = mileageStart != null && mileageEnd != null && mileageEnd >= mileageStart
      ? mileageEnd - mileageStart
      : trip.distance
    const fuelUsed = tripFuelUsed(fuelStart, fuelEnd)
    const armedMinutes = await armedMinutesBetween(database, trip.vehicleId, startedAt, endedAt)

    const changes: Record<string, { from: unknown, to: unknown }> = {}
    const track = (key: string, from: unknown, to: unknown) => {
      if (from instanceof Date || to instanceof Date) {
        if ((from as Date | null)?.getTime() !== (to as Date | null)?.getTime()) changes[key] = { from, to }
        return
      }
      if (from !== to) changes[key] = { from, to }
    }
    track('startedAt', trip.startedAt, startedAt)
    track('endedAt', trip.endedAt, endedAt)
    track('mileageStart', trip.mileageStart, mileageStart)
    track('mileageEnd', trip.mileageEnd, mileageEnd)
    track('distance', trip.distance, distance)
    track('fuelStart', trip.fuelStart, fuelStart)
    track('fuelEnd', trip.fuelEnd, fuelEnd)
    track('fuelUsed', trip.fuelUsed, fuelUsed)
    track('armedMinutes', trip.armedMinutes, armedMinutes)
    report.distanceAfter += distance ?? 0

    // Поездка заводится тем, что вырос одометр. Если после разбора выясняется,
    // что стоял он на месте, запись была не поездкой, а прогревом — сессия его
    // и так помнит. Комментарий или имя водителя означают, что человек с этой
    // строкой уже работал, и такую лучше оставить, чем стереть.
    if (mileageStart != null && mileageEnd != null && distance === 0) {
      const kept = Boolean(trip.comment || trip.driver)
      report.tripsEmptied.push({ id: trip.id, startedAt, kept })
      if (!kept) {
        if (options.apply) await database.delete(trips).where(eq(trips.id, trip.id))
        removed.add(trip.id)
        continue
      }
    }
    if (!Object.keys(changes).length) continue

    report.tripsRewritten.push({ id: trip.id, changes })
    if (options.apply) {
      await database.update(trips).set({
        startedAt, endedAt, mileageStart, mileageEnd, distance, fuelStart, fuelEnd, fuelUsed, armedMinutes
      }).where(eq(trips.id, trip.id))
    }
  }

  return report
}
