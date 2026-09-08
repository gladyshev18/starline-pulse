import { and, asc, eq, gte, inArray, isNotNull, lt, lte } from 'drizzle-orm'
import type { Database } from '../db/client'
import { deviceEvents, vehicleSnapshots } from '../db/schema'
import { summariseStarts, type StartSample } from '../shared/engine-starts'
import { ENGINE_CRANKING, ENGINE_STARTED, ENGINE_STOPPED } from '../shared/starline-events'

// «Начал заводиться» приходит за считанные секунды до «запущен»; всё, что
// дальше, к этому пуску отношения не имеет.
const CRANK_WINDOW_MS = 60_000

// Насколько старым может быть показание вольтметра, чтобы считаться снятым
// перед этим пуском. На стоянке машину опрашивают раз в шесть минут, но бывают
// и часовые дыры — в них напряжение уже жило своей жизнью.
const VOLTAGE_WINDOW_MS = 60 * 60_000

// Пуски по журналу сигнализации, с напряжением, которое батарея показывала
// перед каждым. Считается по всей истории, а не по месяцу: тренд напряжения —
// величина, у которой месяц это одна точка.
export async function startHealth(database: Database, vehicleId: number, start: Date, end: Date) {
  const events = await database.select({ ts: deviceEvents.ts, type: deviceEvents.type })
    .from(deviceEvents)
    .where(and(
      eq(deviceEvents.vehicleId, vehicleId),
      inArray(deviceEvents.type, [ENGINE_STARTED, ENGINE_STOPPED, ENGINE_CRANKING]),
      gte(deviceEvents.ts, start),
      lt(deviceEvents.ts, end)
    ))
    .orderBy(asc(deviceEvents.ts))

  const starts = events.filter(event => event.type === ENGINE_STARTED)
  if (!starts.length) return summariseStarts([])

  // Показания вольтметра забираются одним запросом на всё окно: их тысячи, а
  // выбирать ближайшее к каждому пуску отдельным запросом — это сотня запросов
  // ради того же самого.
  const readings = await database.select({
    ts: vehicleSnapshots.ts,
    battery: vehicleSnapshots.battery,
    engineTemp: vehicleSnapshots.engineTemp
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    eq(vehicleSnapshots.batteryType, 'volt'),
    eq(vehicleSnapshots.ignition, false),
    isNotNull(vehicleSnapshots.battery),
    gte(vehicleSnapshots.ts, new Date(start.getTime() - VOLTAGE_WINDOW_MS)),
    lte(vehicleSnapshots.ts, end)
  )).orderBy(asc(vehicleSnapshots.ts))

  const cranks = events.filter(item => item.type === ENGINE_CRANKING)
  let reading = 0
  let cursor = 0
  const samples: StartSample[] = []
  let previousStop: Date | null = null

  for (const ignition of starts) {
    // Последняя остановка двигателя до этого пуска — это и есть длина стоянки.
    while (cursor < events.length && events[cursor]!.ts <= ignition.ts) {
      if (events[cursor]!.type === ENGINE_STOPPED) previousStop = events[cursor]!.ts
      cursor++
    }

    while (reading + 1 < readings.length && readings[reading + 1]!.ts <= ignition.ts) reading++
    const candidate = readings[reading]
    const fresh = Boolean(candidate
      && candidate.ts <= ignition.ts
      && ignition.ts.getTime() - candidate.ts.getTime() <= VOLTAGE_WINDOW_MS)

    const crank = cranks.find(item =>
      item.ts <= ignition.ts
      && ignition.ts.getTime() - item.ts.getTime() <= CRANK_WINDOW_MS)

    samples.push({
      at: ignition.ts,
      remote: Boolean(crank),
      restVolts: fresh ? candidate!.battery : null,
      restedHours: previousStop && previousStop < ignition.ts
        ? (ignition.ts.getTime() - previousStop.getTime()) / 3_600_000
        : null,
      engineTemp: fresh ? candidate!.engineTemp : null,
      crankSeconds: crank ? (ignition.ts.getTime() - crank.ts.getTime()) / 1000 : null
    })
  }

  return summariseStarts(samples)
}
