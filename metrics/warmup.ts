import { and, asc, eq, gte, lt } from 'drizzle-orm'
import type { Database } from '../db/client'
import { engineSessions } from '../db/schema'
import { WARM_ENGINE_CELSIUS } from '../shared/idle-cost'
import { COOLED_HOURS, summariseColdStarts, warmupModel, type WarmupSample } from '../shared/warmup'
import { measureVehicleIdleRate, resolveFuelPrice } from './idle'

// Холодные пуски месяца. Считаются по всем сессиям двигателя, а не только по
// тем, что стояли: холодный пуск изнашивает двигатель одинаково, поехала машина
// после него или нет.
export async function coldStarts(database: Database, vehicleId: number, start: Date, end: Date) {
  const sessions = await database.select({
    startedAt: engineSessions.startedAt,
    engineTempStart: engineSessions.engineTempStart,
    engineTempEnd: engineSessions.engineTempEnd,
    distance: engineSessions.distance,
    durationMinutes: engineSessions.durationMinutes
  }).from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false),
    gte(engineSessions.startedAt, start),
    lt(engineSessions.startedAt, end)
  )).orderBy(asc(engineSessions.startedAt))

  return summariseColdStarts(sessions)
}

// Сколько минут двигатель работает до того, как машина поедет, и как это
// зависит от погоды.
//
// Погоду показывает сам двигатель: постояв ночь, блок принимает температуру
// воздуха, поэтому в выборку идут только пуски после долгой стоянки. Минуты
// прогрева берутся из сессии: у поехавшей машины — время до первого движения по
// одометру, у стоячей — вся её длительность.
//
// Одометр рапортует кусками, поэтому время до движения завышено на то, что он
// молчал. Ошибка эта одинаковая для всех точек: она приподнимает прямую целиком
// и почти не трогает её наклон, а наклон здесь и есть ответ.
export async function warmupProfile(database: Database, vehicleId: number, now = new Date()) {
  const sessions = await database.select({
    startedAt: engineSessions.startedAt,
    endedAt: engineSessions.endedAt,
    engineTempStart: engineSessions.engineTempStart,
    warmupMinutes: engineSessions.warmupMinutes,
    durationMinutes: engineSessions.durationMinutes,
    isStationary: engineSessions.isStationary
  }).from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false)
  )).orderBy(asc(engineSessions.startedAt))

  const samples: WarmupSample[] = []
  let previousEnd: Date | null = null
  for (const session of sessions) {
    const restedHours = previousEnd ? (session.startedAt.getTime() - previousEnd.getTime()) / 3_600_000 : null
    if (session.endedAt) previousEnd = session.endedAt

    if (restedHours == null || restedHours < COOLED_HOURS) continue
    if (session.engineTempStart == null || session.engineTempStart >= WARM_ENGINE_CELSIUS) continue
    const minutes = session.isStationary ? session.durationMinutes : session.warmupMinutes
    if (minutes == null) continue

    samples.push({ at: session.startedAt, celsius: session.engineTempStart, minutes })
  }

  const rate = await measureVehicleIdleRate(database, vehicleId)
  const { pricePerLitre } = await resolveFuelPrice(database, vehicleId, new Date(0), now)
  return warmupModel(samples, { litresPerHour: rate.litresPerHour, pricePerLitre })
}
