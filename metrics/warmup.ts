import { and, asc, eq, gte, isNotNull, lt, lte } from 'drizzle-orm'
import type { Database } from '../db/client'
import { engineSessions, vehicleSnapshots } from '../db/schema'
import { WARM_ENGINE_CELSIUS } from '../shared/idle-cost'
import { COOLED_HOURS, summariseColdStarts, warmupModel, type WarmupSample } from '../shared/warmup'
import { measureVehicleIdleRate, resolveFuelPrice } from './idle'

// Насколько старым может быть замер, чтобы считаться снятым перед этим пуском.
// На стоянке машину опрашивают раз в шесть минут, но случаются и часовые дыры —
// за час двигатель успевает остыть, и приписывать эту температуру пуску нельзя.
const TEMPERATURE_WINDOW_MS = 60 * 60_000

interface Reading {
  ts: Date
  engineTemp: number
}

// Замеры температуры на заглушенной машине. Забираются одним запросом на всё
// окно: их тысячи, а искать ближайший к каждому пуску отдельным запросом — это
// две сотни запросов ради того же самого.
async function coolReadings(database: Database, vehicleId: number, start: Date, end: Date) {
  const rows = await database.select({
    ts: vehicleSnapshots.ts,
    engineTemp: vehicleSnapshots.engineTemp
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    eq(vehicleSnapshots.ignition, false),
    isNotNull(vehicleSnapshots.engineTemp),
    gte(vehicleSnapshots.ts, new Date(start.getTime() - TEMPERATURE_WINDOW_MS)),
    lte(vehicleSnapshots.ts, end)
  )).orderBy(asc(vehicleSnapshots.ts))
  return rows as Reading[]
}

// Температура перед каждым пуском: последний замер до него, если он достаточно
// свежий. Оба ряда отсортированы, поэтому хватает одного прохода.
function temperaturesBefore(moments: Date[], readings: Reading[]) {
  const result: Array<number | null> = []
  let cursor = 0
  for (const moment of moments) {
    while (cursor + 1 < readings.length && readings[cursor + 1]!.ts <= moment) cursor++
    const candidate = readings[cursor]
    const fresh = candidate
      && candidate.ts <= moment
      && moment.getTime() - candidate.ts.getTime() <= TEMPERATURE_WINDOW_MS
    result.push(fresh ? candidate.engineTemp : null)
  }
  return result
}

// Холодные пуски месяца. Считаются по всем сессиям двигателя, а не только по
// тем, что стояли: холодный пуск изнашивает двигатель одинаково, поехала машина
// после него или нет.
export async function coldStarts(database: Database, vehicleId: number, start: Date, end: Date) {
  const sessions = await database.select({
    startedAt: engineSessions.startedAt,
    engineTempEnd: engineSessions.engineTempEnd,
    distance: engineSessions.distance,
    durationMinutes: engineSessions.durationMinutes
  }).from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false),
    gte(engineSessions.startedAt, start),
    lt(engineSessions.startedAt, end)
  )).orderBy(asc(engineSessions.startedAt))
  if (!sessions.length) return summariseColdStarts([])

  const readings = await coolReadings(database, vehicleId, start, end)
  const before = temperaturesBefore(sessions.map(session => session.startedAt), readings)

  return summariseColdStarts(sessions.map((session, index) => ({
    ...session,
    celsiusBefore: before[index] ?? null
  })))
}

// Сколько минут двигатель работает до того, как машина поедет, и как это
// зависит от погоды.
//
// Погоду показывает сам двигатель: постояв ночь, блок принимает температуру
// воздуха, поэтому в выборку идут только пуски после долгой стоянки, а градусы
// берутся из последнего опроса до пуска. Минуты прогрева — из сессии: у
// поехавшей машины время до первого движения по одометру, у стоячей — вся её
// длительность.
//
// Одометр рапортует кусками, поэтому время до движения завышено на то, что он
// молчал. Ошибка эта одинаковая для всех точек: она приподнимает прямую целиком
// и почти не трогает её наклон, а наклон здесь и есть ответ.
export async function warmupProfile(database: Database, vehicleId: number, now = new Date()) {
  const sessions = await database.select({
    startedAt: engineSessions.startedAt,
    endedAt: engineSessions.endedAt,
    warmupMinutes: engineSessions.warmupMinutes,
    durationMinutes: engineSessions.durationMinutes,
    isStationary: engineSessions.isStationary
  }).from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false)
  )).orderBy(asc(engineSessions.startedAt))
  if (!sessions.length) return warmupModel([])

  const readings = await coolReadings(database, vehicleId, sessions[0]!.startedAt, now)
  const before = temperaturesBefore(sessions.map(session => session.startedAt), readings)

  const samples: WarmupSample[] = []
  let previousEnd: Date | null = null
  for (const [index, session] of sessions.entries()) {
    const restedHours = previousEnd ? (session.startedAt.getTime() - previousEnd.getTime()) / 3_600_000 : null
    if (session.endedAt) previousEnd = session.endedAt

    if (restedHours == null || restedHours < COOLED_HOURS) continue
    const celsius = before[index]
    if (celsius == null || celsius >= WARM_ENGINE_CELSIUS) continue
    const minutes = session.isStationary ? session.durationMinutes : session.warmupMinutes
    if (minutes == null) continue

    samples.push({ at: session.startedAt, celsius, minutes })
  }

  const rate = await measureVehicleIdleRate(database, vehicleId)
  const { pricePerLitre } = await resolveFuelPrice(database, vehicleId, new Date(0), now)
  return warmupModel(samples, { litresPerHour: rate.litresPerHour, pricePerLitre })
}
