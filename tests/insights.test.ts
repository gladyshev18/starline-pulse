import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { deviceEvents, engineSessions, refuelEvents, refuelReceipts, trips, vehicleSnapshots, vehicles } from '../db/schema'
import { insights } from '../metrics/insights'
import { monthStatistics } from '../metrics/statistics'
import { ENGINE_STARTED, ENGINE_STOPPED } from '../shared/starline-events'
import { moscowMonthRange } from '../shared/moscow-month'

const now = new Date('2026-03-15T12:00:00.000Z')

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicleId: vehicle!.id }
}

// Ночной снимок задаёт погоду месяца: сезонность читает температуру двигателя,
// простоявшего до утра.
function night(vehicleId: number, day: string, celsius: number) {
  return {
    vehicleId,
    ts: new Date(`${day}T02:30:00.000Z`),
    ignition: false,
    engineTemp: celsius,
    fuel: 40,
    rawJson: '{}'
  }
}

describe('insights', () => {
  it('собирает тренды по всей истории, а не по одному месяцу', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(vehicleSnapshots).values([
      night(vehicleId, '2026-01-10', -10),
      night(vehicleId, '2026-02-10', 0),
      night(vehicleId, '2026-03-10', 10),
      { vehicleId, ts: new Date('2026-03-02T05:00:00.000Z'), battery: 12.6, batteryType: 'volt', ignition: false, engineTemp: 5, rawJson: '{}' }
    ])
    await database.insert(trips).values([
      { vehicleId, startedAt: new Date('2026-01-12T07:00:00.000Z'), endedAt: new Date('2026-01-12T08:00:00.000Z'), distance: 500, fuelUsed: 55, isOpen: false },
      { vehicleId, startedAt: new Date('2026-02-12T07:00:00.000Z'), endedAt: new Date('2026-02-12T08:00:00.000Z'), distance: 500, fuelUsed: 50, isOpen: false },
      { vehicleId, startedAt: new Date('2026-03-12T07:00:00.000Z'), endedAt: new Date('2026-03-12T08:00:00.000Z'), distance: 500, fuelUsed: 45, isOpen: false }
    ])
    await database.insert(deviceEvents).values([
      { vehicleId, type: ENGINE_STOPPED, ts: new Date('2026-03-01T18:00:00.000Z') },
      { vehicleId, type: ENGINE_STARTED, ts: new Date('2026-03-02T06:00:00.000Z') }
    ])
    await database.insert(refuelReceipts).values([
      { purchasedAt: new Date('2026-01-15T10:00:00.000Z'), station: 'rosneft', stationName: 'Роснефть', fuelType: 'АИ-95', litres: 40, pricePerLitre: 60, totalAmount: 2400, matchStatus: 'auto' },
      { purchasedAt: new Date('2026-02-15T10:00:00.000Z'), station: 'lukoil', stationName: 'Лукойл', fuelType: 'АИ-95', litres: 40, pricePerLitre: 64, totalAmount: 2560, matchStatus: 'auto' }
    ])

    const result = await insights(database, now)
    expect(result.months.map(month => month.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    // Напряжение перед единственным пуском после долгой стоянки.
    expect(result.starts.starts).toBe(1)
    expect(result.starts.voltage.average).toBeCloseTo(12.6)
    // Февральская заправка дороже январской «Роснефти», известной на тот день.
    expect(result.overpay.fills).toBe(1)
    expect(result.overpay.amount).toBeCloseTo(4 * 40)
    expect(result.inflation.main!.fuelType).toBe('АИ-95')
    // Три месяца с погодой и расходом — прямая по ним построена.
    expect(result.seasonality.months).toBe(3)
    expect(result.year!.distance).toBe(1500)
    expect(result.records.busiest).not.toBeNull()
  })

  it('на пустой базе отдаёт пустые сводки, а не падает', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })

    const result = await insights(database, now)
    expect(result.starts.starts).toBe(0)
    expect(result.warmup.samples).toBe(0)
    expect(result.overpay.amount).toBe(0)
    expect(result.seasonality.months).toBe(0)
    expect(result.year).toBeNull()
    expect(result.months).toEqual([])
  })
})

describe('monthStatistics', () => {
  it('добавляет к месяцу полноту чеков, стояние заведённым и холодные пуски', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(vehicleSnapshots).values([
      { vehicleId, ts: new Date('2026-02-01T06:00:00.000Z'), fuel: 40, mileage: 1000, rawJson: '{}' },
      { vehicleId, ts: new Date('2026-02-27T18:00:00.000Z'), fuel: 30, mileage: 1500, rawJson: '{}' },
      // Замеры на заглушенной машине перед пусками: по ним и решается, холодным
      // был пуск или на ещё горячем двигателе.
      { vehicleId, ts: new Date('2026-02-12T06:55:00.000Z'), ignition: false, engineTemp: 5, rawJson: '{}' },
      { vehicleId, ts: new Date('2026-02-13T06:55:00.000Z'), ignition: false, engineTemp: 3, rawJson: '{}' }
    ])
    await database.insert(trips).values([
      { vehicleId, startedAt: new Date('2026-02-12T07:00:00.000Z'), endedAt: new Date('2026-02-12T08:00:00.000Z'), distance: 500, fuelUsed: 45, isOpen: false }
    ])
    await database.insert(engineSessions).values([
      // Холодный пуск с поездкой и стоячий прогрев на морозе.
      { vehicleId, startedAt: new Date('2026-02-12T07:00:00.000Z'), endedAt: new Date('2026-02-12T08:00:00.000Z'), engineTempStart: 5, engineTempEnd: 90, distance: 500, durationMinutes: 60, isStationary: false, isOpen: false },
      { vehicleId, startedAt: new Date('2026-02-13T07:00:00.000Z'), endedAt: new Date('2026-02-13T07:12:00.000Z'), engineTempStart: 3, engineTempEnd: 60, distance: 0, durationMinutes: 12, isStationary: true, isOpen: false }
    ])
    await database.insert(refuelEvents).values([
      { vehicleId, detectedAt: new Date('2026-02-10T10:00:00.000Z'), litresAdded: 40, sensorLitresAdded: 39, totalAmount: 2600, pricePerLitre: 65 },
      // Заправка без чека: литры видит датчик, рублей у неё нет.
      { vehicleId, detectedAt: new Date('2026-02-20T10:00:00.000Z'), litresAdded: null, sensorLitresAdded: 20, totalAmount: null }
    ])

    const stats = await monthStatistics(database, moscowMonthRange('2026-02')!, now)
    expect(stats.coverage.refuels).toBe(2)
    expect(stats.coverage.share).toBeCloseTo(40 / 60)
    expect(stats.coverage.missingAmount).toBeCloseTo(20 * 65)
    expect(stats.coldStarts.cold).toBe(2)
    expect(stats.coldStarts.per1000Km).toBeCloseTo(4)
    // Двенадцать минут стоячего прогрева оплачены по цене месяца.
    expect(stats.idle.minutes).toBeCloseTo(12)
    expect(stats.idle.cost).toBeGreaterThan(0)
  })
})
