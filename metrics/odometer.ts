import { and, asc, eq, gt, gte, isNotNull, lte, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { engineSessions, vehicleSnapshots } from '../db/schema'
import { MAX_POLL_GAP_MS } from './engine'

export type SessionWindow = {
  vehicleId: number
  startedAt: Date
  endedAt: Date | null
}

// Одометр отдаёт пробег кусками по десять-двадцать километров и досылает
// остаток уже после того, как зажигание выключили, — иногда через минуты, а
// иногда только в том опросе, где машину успели завести снова. Отделить своё от
// чужого по флагу зажигания в снапшоте нельзя, но у самого показания есть своё
// время, `mileage_ts`, и оно честно говорит, на какой момент этот пробег снят.
//
// Отсюда единственный вопрос, на который данные вообще позволяют ответить: где
// стоял одометр к моменту `at`. Это максимум показаний, снятых не позже `at`, —
// кто бы их ни привёз и когда бы они ни доехали до опроса.
async function odometerAt(database: Database, vehicleId: number, at: Date) {
  const [row] = await database.select({
    mileage: sql<number | null>`max(${vehicleSnapshots.mileage})`
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    isNotNull(vehicleSnapshots.mileage),
    lte(sql`coalesce(${vehicleSnapshots.mileageTs}, ${vehicleSnapshots.ts})`, at.getTime())
  ))
  return row?.mileage == null ? null : Number(row.mileage)
}

// Сессия целиком прошла на охране: двигатель работал, а сигнализация ни разу не
// была снята. Ехать на охраняемой машине нельзя, значит это автозапуск, и ни
// одного километра ему не принадлежит. Прямое подтверждение есть и в сыром
// ответе — `state.r_start`, — но охрана при заведённом двигателе говорит то же
// самое и уже лежит в снапшоте.
//
// Это единственное доказательство, которое здесь работает, и `mileage_ts` его не
// заменяет: OBD просыпается вместе с двигателем и берёт свежее чтение со свежей
// меткой. За август так вышло девять раз, и восемь чтений совпали с прежним
// значением, а девятое — 28 августа — оказалось на километр больше. Метка у него
// стояла утренняя, хотя километр был вчерашний: накануне OBD отчитался в 11:46,
// а зажигание выключили в 11:48, и одометр щёлкнул в эти две минуты. Отличить
// такой километр от проеханного можно только по охране.
async function isRemoteStartWarmup(database: Database, session: SessionWindow) {
  const inside = (armed: boolean) => and(
    eq(vehicleSnapshots.vehicleId, session.vehicleId),
    eq(vehicleSnapshots.ignition, true),
    eq(vehicleSnapshots.armed, armed),
    gte(vehicleSnapshots.ts, session.startedAt),
    session.endedAt ? lte(vehicleSnapshots.ts, session.endedAt) : undefined
  )
  // Сессия без единого снапшота с заведённым двигателем — это провал опроса, а
  // не автозапуск, и молчание не должно читаться как «машина стояла».
  const guarded = await database.query.vehicleSnapshots.findFirst({ columns: { id: true }, where: inside(true) })
  if (!guarded) return false
  const free = await database.query.vehicleSnapshots.findFirst({ columns: { id: true }, where: inside(false) })
  return free == null
}

// Момент, после которого показания одометра принадлежат уже не этой сессии.
//
// Границ две, берётся ближайшая. Первая — запуск следующей сессии, которой
// можно было ехать: дальше считает она. Прогревы на автозапуске между ними
// пропускаются: проехать они не могли, а прочитать одометр заново — могут, и
// тогда чужой километр застрял бы между двумя дорогами вместо той, которая его
// проехала.
//
// Вторая — рост счётчика моточасов там, где сессии нет вовсе: двигатель работал,
// а опрос это проспал, и такой пробег принадлежит той поездке, а не этой.
async function mileageBoundary(database: Database, session: SessionWindow) {
  if (!session.endedAt) return null

  const following = await database.select({
    id: engineSessions.id,
    vehicleId: engineSessions.vehicleId,
    startedAt: engineSessions.startedAt,
    endedAt: engineSessions.endedAt
  }).from(engineSessions).where(and(
    eq(engineSessions.vehicleId, session.vehicleId),
    gt(engineSessions.startedAt, session.startedAt)
  )).orderBy(asc(engineSessions.startedAt)).limit(10)

  let nextDrivable: Date | null = null
  for (const item of following) {
    if (await isRemoteStartWarmup(database, item)) continue
    nextDrivable = item.startedAt
    break
  }

  // Счётчик досчитывает последнюю минуту сессии уже в том опросе, который
  // застаёт зажигание выключенным, поэтому за итог сессии берётся именно это
  // показание. Сравнивать с последним показанием до остановки нельзя: рост на
  // ту самую минуту оборвал бы отсчёт сразу, до всякой досылки.
  const settled = await database.query.vehicleSnapshots.findFirst({
    columns: { motorMinutes: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, session.vehicleId),
      isNotNull(vehicleSnapshots.motorMinutes),
      gte(vehicleSnapshots.ts, session.endedAt)
    ),
    orderBy: asc(vehicleSnapshots.ts)
  })
  // Двигатель проработал целиком между двумя опросами, и ни одна сессия этого не
  // видела: значит там была поездка, о которой нет записи, и она стоит между
  // этой сессией и одометром. Дальше её начала считать чужое.
  //
  // Порог в один разрыв опроса отделяет её от опроса, который просто опоздал к
  // запуску: пока двигатель работает, машину опрашивают раз в полминуты, поэтому
  // три минуты счётчика перед стартом сессии — это её же начало, а тридцать —
  // отдельная дорога.
  const unrecorded = settled?.motorMinutes == null ? [] : await database.all<{ from_ts: number }>(sql`
    with steps as (
      select
        ${vehicleSnapshots.ts} as ts,
        ${vehicleSnapshots.motorMinutes} as value,
        lag(${vehicleSnapshots.ts}) over (order by ${vehicleSnapshots.ts}) as prev_ts,
        lag(${vehicleSnapshots.motorMinutes}) over (order by ${vehicleSnapshots.ts}) as prev_value
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${session.vehicleId}
        and ${vehicleSnapshots.ts} > ${session.endedAt.getTime()}
        and ${vehicleSnapshots.motorMinutes} is not null
    )
    select prev_ts as from_ts from steps
    where prev_value is not null
      and value > ${settled.motorMinutes}
      and value - prev_value > ${MAX_POLL_GAP_MS / 60_000}
      and not exists (
        select 1 from ${engineSessions}
        where ${engineSessions.vehicleId} = ${session.vehicleId}
          and ${engineSessions.startedAt} <= steps.prev_ts
          and coalesce(${engineSessions.endedAt}, steps.ts) >= steps.ts
      )
    order by prev_ts
    limit 1
  `)

  const edges = [nextDrivable, unrecorded[0]?.from_ts == null ? null : new Date(Number(unrecorded[0].from_ts))]
    .filter((value): value is Date => value != null)
  return edges.length ? new Date(Math.min(...edges.map(value => value.getTime()))) : new Date()
}

// Докуда одометр досчитал за сессию. Всё, что снято до следующего запуска
// двигателя, принадлежит ей, включая досылку, приехавшую уже на стоянке; всё,
// что снято после, — не её, даже если приехало тем же опросом.
//
// Проверено на боевых данных за август: сумма таких отрезков по всем сессиям
// сошлась с разностью крайних показаний одометра до километра, тогда как
// записанные `distance` давали лишние 24 км — досылка попадала сразу в две
// сессии, и обе засчитывали её себе.
async function sessionOdometerEnd(database: Database, session: SessionWindow) {
  const boundary = await mileageBoundary(database, session)
  if (!boundary) return null
  // Прогрев на автозапуске никуда не ехал, чем бы ни отчитался OBD в эти минуты.
  // Отрезок остаётся нулевым, а километры достаются той сессии, которая их
  // проехала: она пропускает прогрев при поиске своей границы.
  if (await isRemoteStartWarmup(database, session)) {
    return await odometerAt(database, session.vehicleId, session.startedAt)
  }
  return await odometerAt(database, session.vehicleId, boundary)
}

// Отрезок одометра целиком: и начало, и конец по одному правилу.
//
// Начало нельзя брать из снапшота, который застал зажигание включённым:
// показание в нём снято раньше — иногда на час, — и следующая сессия
// открывается на том же числе, которое предыдущая уже успела отдать как свой
// конец. Взятые по одному правилу, соседние отрезки стыкуются: конец одного и
// есть начало другого, и сумма сходится с одометром без остатка.
export async function sessionOdometerSpan(database: Database, session: SessionWindow) {
  const mileageStart = await odometerAt(database, session.vehicleId, session.startedAt)
  const mileageEnd = await sessionOdometerEnd(database, session)
  const distance = mileageStart != null && mileageEnd != null && mileageEnd >= mileageStart
    ? mileageEnd - mileageStart
    : null
  return { mileageStart, mileageEnd, distance }
}
