import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { engineSessions, vehicleSnapshots, vehicles } from '../db/schema'
import { coldStarts, warmupProfile } from '../metrics/warmup'
import { coldStartVerdict, summariseColdStarts, warmupModel, type EngineStartSession, type WarmupSample } from '../shared/warmup'

function session(temp: number | null, distance: number, end: number | null = 90): EngineStartSession {
  return {
    startedAt: new Date('2026-01-05T06:00:00.000Z'),
    celsiusBefore: temp,
    engineTempEnd: end,
    distance,
    durationMinutes: 20
  }
}

describe('summariseColdStarts', () => {
  it('делит пуски по температуре перед пуском и считает их на тысячу километров', () => {
    const summary = summariseColdStarts([
      session(20, 100),
      session(15, 150),
      session(85, 250),
      session(null, 100)
    ])
    expect(summary.sessions).toBe(4)
    expect(summary.cold).toBe(2)
    expect(summary.warm).toBe(1)
    expect(summary.unknown).toBe(1)
    expect(summary.distance).toBe(600)
    expect(summary.per1000Km).toBeCloseTo(2 / 600 * 1000)
  })

  it('называет поездки, в которых двигатель так и не прогрелся', () => {
    const summary = summariseColdStarts([
      session(10, 3, 45),
      session(10, 30, 89),
      // Пуск на горячем двигателе спрашивать не о чем: он и не остывал.
      session(80, 2, 60)
    ])
    expect(summary.neverWarm).toBe(1)
    expect(summary.neverWarmDistance).toBe(3)
  })

  it('на пустом месяце не делит на ноль', () => {
    const summary = summariseColdStarts([])
    expect(summary.per1000Km).toBeNull()
    expect(summary.sessions).toBe(0)
  })
})

describe('coldStartVerdict', () => {
  it('меряет пуски километрами на пуск против порога короткой поездки', () => {
    const summary = summariseColdStarts([session(10, 14), session(10, 14)])
    const verdict = coldStartVerdict(summary, 5)!
    expect(verdict.kmPerStart).toBeCloseTo(14)
    expect(verdict.thresholdKm).toBe(8)
    expect(verdict.severe).toBe(false)
  })

  it('в мороз поднимает порог вдвое', () => {
    const summary = summariseColdStarts([session(-10, 14), session(-10, 14, 50)])
    const verdict = coldStartVerdict(summary, -5)!
    expect(verdict.thresholdKm).toBe(16)
    expect(verdict.severe).toBe(true)
    expect(verdict.neverWarmShare).toBeCloseTo(0.5)
  })

  it('без холодных пусков судить не о чем', () => {
    expect(coldStartVerdict(summariseColdStarts([session(80, 20)]), 5)).toBeNull()
  })
})

function warmup(celsius: number, minutes: number): WarmupSample {
  return { at: new Date('2026-01-05T06:00:00.000Z'), celsius, minutes }
}

describe('warmupModel', () => {
  it('находит, на сколько минут удлиняется прогрев от каждых десяти градусов холода', () => {
    const model = warmupModel([
      warmup(20, 2),
      warmup(10, 4),
      warmup(0, 6),
      warmup(-10, 8)
    ], { litresPerHour: 0.9, pricePerLitre: 70 })

    expect(model.samples).toBe(4)
    expect(model.minutesPerTenDegrees).toBeCloseTo(2)
    expect(model.averageMinutes).toBeCloseTo(5)
    // Прогноз строится только внутри той погоды, что машина видела: минус
    // двадцать в выборке не было, и обещать по прямой мороз нечестно.
    expect(model.forecast.map(item => item.celsius)).toEqual([-10, 0, 10, 20])
    const frost = model.forecast[0]!
    expect(frost.minutes).toBeCloseTo(8)
    expect(frost.litres).toBeCloseTo(8 / 60 * 0.9)
    expect(frost.cost).toBeCloseTo(8 / 60 * 0.9 * 70)
  })

  it('молчит о зависимости, пока прогревы разбросаны случайно', () => {
    const model = warmupModel([
      warmup(20, 6),
      warmup(10, 3),
      warmup(0, 7),
      warmup(-5, 4)
    ])
    expect(model.minutesPerTenDegrees).toBeNull()
    expect(model.forecast).toEqual([])
    // Среднее всё равно есть: сказать, сколько обычно греется, можно и без
    // зависимости от погоды.
    expect(model.averageMinutes).toBeCloseTo(5)
  })

  it('выбрасывает забытую заведённой машину', () => {
    const model = warmupModel([warmup(0, 5), warmup(0, 120), warmup(-10, 8)])
    expect(model.samples).toBe(2)
  })
})

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicleId: vehicle!.id }
}

function row(vehicleId: number, at: string, values: Partial<typeof engineSessions.$inferInsert>) {
  return {
    vehicleId,
    startedAt: new Date(at),
    endedAt: new Date(new Date(at).getTime() + 20 * 60_000),
    isOpen: false,
    ...values
  }
}

// Замер на заглушенной машине за пять минут до пуска — то, из чего берётся
// погода: `engine_temp_start` сессии к этому моменту уже нагрет работой.
function before(vehicleId: number, at: string, celsius: number) {
  return {
    vehicleId,
    ts: new Date(new Date(at).getTime() - 5 * 60_000),
    ignition: false,
    engineTemp: celsius,
    rawJson: '{}'
  }
}

describe('warmupProfile', () => {
  it('берёт погоду из замера до пуска и только после долгой стоянки', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(engineSessions).values([
      // Самая первая сессия истории в модель не идёт: сколько машина стояла до
      // неё, сказать нечем.
      row(vehicleId, '2025-12-31T06:00:00.000Z', { warmupMinutes: 5, durationMinutes: 20, isStationary: false }),
      row(vehicleId, '2026-01-01T06:00:00.000Z', { warmupMinutes: 6, durationMinutes: 20, isStationary: false }),
      // Через час после предыдущей: машина не остыла, и её температура — не погода.
      row(vehicleId, '2026-01-01T07:00:00.000Z', { warmupMinutes: 1, durationMinutes: 20, isStationary: false }),
      row(vehicleId, '2026-01-02T06:00:00.000Z', { warmupMinutes: 8, durationMinutes: 20, isStationary: false }),
      row(vehicleId, '2026-01-03T06:00:00.000Z', { warmupMinutes: 4, durationMinutes: 20, isStationary: false })
    ])
    await database.insert(vehicleSnapshots).values([
      before(vehicleId, '2025-12-31T06:00:00.000Z', 10),
      before(vehicleId, '2026-01-01T06:00:00.000Z', 10),
      before(vehicleId, '2026-01-01T07:00:00.000Z', 75),
      before(vehicleId, '2026-01-02T06:00:00.000Z', 0),
      before(vehicleId, '2026-01-03T06:00:00.000Z', 20)
    ])

    const model = await warmupProfile(database, vehicleId, new Date('2026-02-01T00:00:00.000Z'))
    expect(model.samples).toBe(3)
    expect(model.coldest).toBe(0)
    expect(model.warmest).toBe(20)
  })

  it('не берёт пуск, перед которым свежего замера не было', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(engineSessions).values([
      row(vehicleId, '2026-01-01T06:00:00.000Z', { warmupMinutes: 6, durationMinutes: 20, isStationary: false }),
      row(vehicleId, '2026-01-02T06:00:00.000Z', { warmupMinutes: 8, durationMinutes: 20, isStationary: false })
    ])
    await database.insert(vehicleSnapshots).values([
      // Замер трёхчасовой давности: за это время двигатель жил своей жизнью.
      { vehicleId, ts: new Date('2026-01-02T03:00:00.000Z'), ignition: false, engineTemp: 5, rawJson: '{}' }
    ])

    const model = await warmupProfile(database, vehicleId, new Date('2026-02-01T00:00:00.000Z'))
    expect(model.samples).toBe(0)
  })

  it('у стоячего прогрева минутами считается вся сессия', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(engineSessions).values([
      row(vehicleId, '2025-12-31T06:00:00.000Z', { warmupMinutes: null, durationMinutes: 12, isStationary: true }),
      row(vehicleId, '2026-01-01T06:00:00.000Z', { warmupMinutes: null, durationMinutes: 9, isStationary: true }),
      row(vehicleId, '2026-01-02T06:00:00.000Z', { warmupMinutes: null, durationMinutes: 6, isStationary: true }),
      row(vehicleId, '2026-01-03T06:00:00.000Z', { warmupMinutes: null, durationMinutes: 3, isStationary: true })
    ])
    await database.insert(vehicleSnapshots).values([
      before(vehicleId, '2025-12-31T06:00:00.000Z', 5),
      before(vehicleId, '2026-01-01T06:00:00.000Z', 10),
      before(vehicleId, '2026-01-02T06:00:00.000Z', 15),
      before(vehicleId, '2026-01-03T06:00:00.000Z', 25)
    ])

    const model = await warmupProfile(database, vehicleId, new Date('2026-02-01T00:00:00.000Z'))
    expect(model.samples).toBe(3)
    expect(model.medianMinutes).toBe(6)
  })
})

describe('coldStarts', () => {
  it('считает сессии месяца по температуре перед пуском', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(engineSessions).values([
      row(vehicleId, '2026-01-20T06:00:00.000Z', { engineTempEnd: 88, distance: 10, durationMinutes: 20, isStationary: false }),
      row(vehicleId, '2026-02-03T06:00:00.000Z', { engineTempEnd: 88, distance: 20, durationMinutes: 20, isStationary: false }),
      row(vehicleId, '2026-02-04T06:00:00.000Z', { engineTempEnd: 90, distance: 30, durationMinutes: 20, isStationary: false })
    ])
    await database.insert(vehicleSnapshots).values([
      before(vehicleId, '2026-01-20T06:00:00.000Z', 5),
      before(vehicleId, '2026-02-03T06:00:00.000Z', 5),
      // Второй февральский пуск — на ещё горячем двигателе.
      before(vehicleId, '2026-02-04T06:00:00.000Z', 85)
    ])

    const summary = await coldStarts(
      database,
      vehicleId,
      new Date('2026-01-31T21:00:00.000Z'),
      new Date('2026-02-28T21:00:00.000Z')
    )
    expect(summary.sessions).toBe(2)
    expect(summary.cold).toBe(1)
    expect(summary.warm).toBe(1)
    expect(summary.distance).toBe(50)
    expect(summary.per1000Km).toBeCloseTo(20)
  })
})
