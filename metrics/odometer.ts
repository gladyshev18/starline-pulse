import { and, asc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { deviceEvents, engineSessions, vehicleSnapshots } from '../db/schema'
import { HANDBRAKE_RELEASED } from '../shared/starline-events'

// Показание одометра говорит ровно одно: к моменту `at` счётчик дошёл до
// `value`. Когда именно между этим показанием и предыдущим машина накрутила
// разницу — оно не говорит, и в этом вся сложность.
//
// Прежний разбор считал, что километры принадлежат той сессии, в чьё окно
// попала метка. На разреженных показаниях это разваливается: 29 августа
// десять километров доехали одним показанием в 13:20 и покрывали сразу три
// отрезка — хвост одной поездки, всю следующую и ещё одну. Достались они
// последней, не влезли в её две минуты, и вышло 134 км/ч.
export interface OdometerReading {
  value: number
  at: Date
}

// Отрезок времени, в течение которого машина могла ехать. Начало — «ручник
// опущен», если сигнализация о нём сообщила, иначе запуск двигателя. Конец —
// выключение зажигания.
export interface MovingWindow {
  id: number
  from: Date
  to: Date
}

export interface DistributedDistance {
  id: number
  distance: number
}

// Километры между двумя соседними показаниями делятся между окнами движения
// пропорционально тому, сколько каждое из них занимает внутри промежутка.
//
// Это предположение о постоянной средней скорости внутри промежутка, и другого
// данные не позволяют: отличить медленную езду от стоянки с работающим
// двигателем нечем. Зато ни один километр не теряется и не удваивается, а сумма
// по всем окнам в точности равна разности крайних показаний.
export function distributeOdometer(readings: OdometerReading[], windows: MovingWindow[]) {
  const distances = new Map<number, number>(windows.map(item => [item.id, 0]))
  let unattributed = 0

  for (let index = 1; index < readings.length; index++) {
    const previous = readings[index - 1]!
    const current = readings[index]!
    const delta = current.value - previous.value
    if (!(delta > 0)) continue

    const shares = windows
      .map(item => ({
        id: item.id,
        overlap: Math.max(0, Math.min(item.to.getTime(), current.at.getTime()) - Math.max(item.from.getTime(), previous.at.getTime()))
      }))
      .filter(item => item.overlap > 0)
    const total = shares.reduce((sum, item) => sum + item.overlap, 0)
    // Двигатель не работал ни минуты, а одометр вырос: это поездка, которую
    // опрос не увидел вовсе. Приписывать её соседям нельзя, поэтому километры
    // остаются ничьими — и расхождение с одометром честно покажет, что запись
    // неполная.
    if (!total) { unattributed += delta; continue }
    for (const share of shares) {
      distances.set(share.id, (distances.get(share.id) ?? 0) + delta * (share.overlap / total))
    }
  }

  return { distances, unattributed }
}

async function odometerReadings(database: Database, vehicleId: number): Promise<OdometerReading[]> {
  const rows = await database.select({
    value: vehicleSnapshots.mileage,
    at: sql<number>`coalesce(${vehicleSnapshots.mileageTs}, ${vehicleSnapshots.ts})`
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    isNotNull(vehicleSnapshots.mileage)
  )).orderBy(sql`coalesce(${vehicleSnapshots.mileageTs}, ${vehicleSnapshots.ts})`, asc(vehicleSnapshots.mileage))

  // Одно и то же показание приходит десятками опросов подряд, а изредка счётчик
  // отдаёт значение меньше прежнего. Оставляем только моменты, когда он реально
  // сдвинулся вперёд.
  const readings: OdometerReading[] = []
  for (const row of rows) {
    const value = Number(row.value)
    const last = readings.at(-1)
    if (last && value <= last.value) continue
    readings.push({ value, at: new Date(Number(row.at)) })
  }
  return readings
}

// Сессия целиком прошла на охране: двигатель работал, а сигнализация ни разу не
// была снята. Ехать на охраняемой машине нельзя, значит это автозапуск, и окно
// движения у него пустое — ни одного километра ему не достанется.
async function isRemoteStartWarmup(database: Database, session: { vehicleId: number, startedAt: Date, endedAt: Date }) {
  const inside = (armed: boolean) => and(
    eq(vehicleSnapshots.vehicleId, session.vehicleId),
    eq(vehicleSnapshots.ignition, true),
    eq(vehicleSnapshots.armed, armed),
    gte(vehicleSnapshots.ts, session.startedAt),
    lte(vehicleSnapshots.ts, session.endedAt)
  )
  // Сессия без единого снапшота с заведённым двигателем — это провал опроса, а
  // не автозапуск, и молчание не должно читаться как «машина стояла».
  const guarded = await database.query.vehicleSnapshots.findFirst({ columns: { id: true }, where: inside(true) })
  if (!guarded) return false
  const free = await database.query.vehicleSnapshots.findFirst({ columns: { id: true }, where: inside(false) })
  return free == null
}

// Момент, когда машина тронулась. «Ручник опущен» — единственная точная отметка
// начала движения, какая есть: на боевых данных она приходит у 97 % поездок и ни
// у одного прогрева на автозапуске. Обратной отметки нет — приехав, глушат
// двигатель кнопкой, и ручник встаёт уже после того, как блоку нечего
// передавать, поэтому конец окна — выключение зажигания.
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

export interface SessionDistance {
  sessionId: number
  startedAt: Date
  endedAt: Date
  departedAt: Date | null
  mileageStart: number | null
  mileageEnd: number | null
  distance: number
}

// Пробег всех сессий разом. По одной его посчитать нельзя: доля зависит от того,
// кто ещё делил тот же промежуток между показаниями.
export async function sessionDistances(database: Database, vehicleId: number) {
  const sessions = await database.select().from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    isNotNull(engineSessions.endedAt)
  )).orderBy(asc(engineSessions.startedAt))
  if (!sessions.length) return { sessions: [] as SessionDistance[], unattributed: 0 }

  const readings = await odometerReadings(database, vehicleId)
  const departures = new Map<number, Date | null>()
  const windows: MovingWindow[] = []
  for (const session of sessions) {
    const endedAt = session.endedAt!
    const remote = await isRemoteStartWarmup(database, { vehicleId, startedAt: session.startedAt, endedAt })
    const departedAt = remote ? null : await departureWithin(database, vehicleId, session.startedAt, endedAt)
    departures.set(session.id, departedAt)
    const from = departedAt && departedAt >= session.startedAt && departedAt <= endedAt ? departedAt : session.startedAt
    windows.push({ id: session.id, from: remote ? session.startedAt : from, to: remote ? session.startedAt : endedAt })
  }

  const { distances, unattributed } = distributeOdometer(readings, windows)

  // Показания одометра целые, а доли — нет. Чтобы соседние записи по-прежнему
  // стыковались, начало каждой берётся там, где кончилась предыдущая: сумма
  // тогда в точности равна разности крайних показаний.
  let running: number | null = readings[0]?.value ?? null
  const result: SessionDistance[] = []
  for (const session of sessions) {
    const distance = distances.get(session.id) ?? 0
    const mileageStart: number | null = running
    running = running == null ? null : running + distance
    result.push({
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt!,
      departedAt: departures.get(session.id) ?? null,
      mileageStart,
      mileageEnd: running,
      distance
    })
  }
  return { sessions: result, unattributed }
}
