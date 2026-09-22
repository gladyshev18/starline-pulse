import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { deviceEvents, engineSessions, vehicleSnapshots } from '../db/schema'
import { GUARD_OFF, GUARD_ON, HANDBRAKE_RELEASED } from '../shared/starline-events'

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

// На охране ли стояла машина, когда завёлся двигатель, — по журналу
// сигнализации. Последнее событие охраны перед запуском и отвечает на этот
// вопрос: хозяин снимает охрану и только потом заводит, автозапуск крутит
// стартёр, не снимая.
//
// Журнал ведёт сам блок, поэтому он знает это и о запусках, которых опрос не
// видел вовсе.
async function guardedWhenStarted(database: Database, vehicleId: number, startedAt: Date) {
  const event = await database.query.deviceEvents.findFirst({
    columns: { type: true },
    where: and(
      eq(deviceEvents.vehicleId, vehicleId),
      inArray(deviceEvents.type, [GUARD_ON, GUARD_OFF]),
      lte(deviceEvents.ts, startedAt)
    ),
    orderBy: desc(deviceEvents.ts)
  })
  return event ? event.type === GUARD_ON : null
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
  const guarded = await database.query.vehicleSnapshots.findFirst({ columns: { id: true }, where: inside(true) })
  // Сессия без единого снапшота с заведённым двигателем — это провал опроса, а
  // не автозапуск. Молчание опроса само по себе не значит «машина стояла», но и
  // читать его как «ехала» нельзя: стоящую на охране машину опрос навещает раз
  // в пять минут, и короткий прогрев укладывается между двумя визитами целиком.
  // Так 10 сентября восьмидесятисекундный автозапуск стал четвёртой поездкой
  // дня, забрав себе полкилометра из досылки одометра за предыдущую дорогу.
  //
  // Ответ есть у журнала сигнализации: он видел и состояние охраны в момент
  // запуска, и опущенный ручник, если машина всё-таки тронулась. Прогрев — это
  // запуск на охране, за который машина никуда не поехала.
  if (!guarded) {
    if (await departureWithin(database, session.vehicleId, session.startedAt, session.endedAt)) return false
    return await guardedWhenStarted(database, session.vehicleId, session.startedAt) === true
  }
  const free = await database.query.vehicleSnapshots.findFirst({ columns: { id: true }, where: inside(false) })
  return free == null
}

// «Ручник опущен» из журнала сигнализации. Отъездом это событие не является —
// см. словарь кодов: блок отчитывается им о состоянии CAN при пробуждении, в
// среднем через двенадцать секунд после зажигания. Но как начало окна движения
// оно годится: раньше него машина точно не ехала, и ни одному прогреву на
// автозапуске оно не приходит. Обратной отметки нет — приехав, глушат двигатель
// кнопкой, — поэтому конец окна — выключение зажигания.
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

// Когда машина тронулась — по одометру, потому что другого свидетеля нет.
//
// Ручник отвечает на этот вопрос всегда одно и то же: «через полминуты после
// зажигания», и вычитать по нему нечего. Счётчик моточасов идёт и на стоянке.
// Координаты вышечные: отличить стоянку от езды по городу они не дают.
//
// Зато одометр, отчитавшись первый раз, задаёт темп: если после первого
// показания машина прошла столько-то километров за столько-то времени, то и
// километры до него она накрутила примерно тем же ходом. Остаток от промежутка
// между зажиганием и первым показанием — стоянка: сел, завёл, прогрел стёкла,
// дождался попутчика.
//
// Оценка намеренно скупая. Темп берётся по всему остатку поездки вместе с её
// собственными остановками, то есть занижен, а занижённый темп отдаёт езде
// больше минут, чем та потребовала, и стоянку тем самым укорачивает. Ошибиться
// в эту сторону безопасно: скорость выйдет меньше настоящей, а не больше.
export function departureFromOdometer(
  readings: OdometerReading[],
  session: { startedAt: Date, endedAt: Date, mileageStart: number | null }
) {
  if (session.mileageStart == null) return null
  const inside = readings.filter(item => item.at > session.startedAt && item.at <= session.endedAt)
  // Одно показание за всю поездку не говорит ни о каком темпе: те же километры
  // могли быть проеханы и за десять минут, и за две. Поездка остаётся как есть.
  const first = inside[0]
  const last = inside.at(-1)
  if (!first || !last || first === last) return null

  const pace = (last.value - first.value) / (last.at.getTime() - first.at.getTime())
  if (!(pace > 0)) return null
  const before = first.value - session.mileageStart
  if (!(before >= 0)) return null

  const standingMs = first.at.getTime() - session.startedAt.getTime() - before / pace
  if (!(standingMs > 0)) return null
  return new Date(session.startedAt.getTime() + standingMs)
}

// Из двух отметок отъезда берётся поздняя: обе говорят «раньше этого машина не
// ехала», и та, что позже, просто знает больше.
function laterOf(left: Date | null, right: Date | null) {
  if (!left) return right
  if (!right) return left
  return right > left ? right : left
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
  const remote = new Set<number>()
  const windows: MovingWindow[] = []
  for (const session of sessions) {
    const endedAt = session.endedAt!
    const warmup = await isRemoteStartWarmup(database, { vehicleId, startedAt: session.startedAt, endedAt })
    if (warmup) remote.add(session.id)
    const departedAt = warmup ? null : await departureWithin(database, vehicleId, session.startedAt, endedAt)
    departures.set(session.id, departedAt)
    const from = departedAt && departedAt >= session.startedAt && departedAt <= endedAt ? departedAt : session.startedAt
    windows.push({ id: session.id, from: warmup ? session.startedAt : from, to: warmup ? session.startedAt : endedAt })
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
    // Отметка отъезда считается здесь, а не выше вместе с окнами: ей нужен
    // одометр на начало сессии, а он известен только после раздачи километров.
    // На окна она не влияет намеренно — окно решает, чьи это километры, и
    // сдвинуть его значило бы пересчитать пробег всем соседям сразу.
    const moved = remote.has(session.id)
      ? null
      : departureFromOdometer(readings, { startedAt: session.startedAt, endedAt: session.endedAt!, mileageStart })
    result.push({
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt!,
      departedAt: laterOf(departures.get(session.id) ?? null, moved),
      mileageStart,
      mileageEnd: running,
      distance
    })
  }
  return { sessions: result, unattributed }
}
