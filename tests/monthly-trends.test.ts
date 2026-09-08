import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { refuelEvents, trips, vehicleSnapshots, vehicles } from '../db/schema'
import { monthlyTrends } from '../metrics/monthly'

const now = new Date('2026-03-15T12:00:00.000Z')

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicleId: vehicle!.id }
}

function reading(vehicleId: number, at: string, fuel: number) {
  return { vehicleId, ts: new Date(at), fuel, rawJson: '{}' }
}

function trip(vehicleId: number, at: string, distance: number, fuelUsed: number) {
  return {
    vehicleId,
    startedAt: new Date(at),
    endedAt: new Date(new Date(at).getTime() + 30 * 60_000),
    distance,
    fuelUsed,
    isOpen: false
  }
}

describe('monthlyTrends', () => {
  it('считает месяц теми же величинами, что и карточка месяца', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values([
        reading(vehicleId, '2026-01-05T09:00:00.000Z', 40),
        reading(vehicleId, '2026-01-28T18:00:00.000Z', 20),
        reading(vehicleId, '2026-02-03T09:00:00.000Z', 20),
        reading(vehicleId, '2026-02-25T18:00:00.000Z', 30)
      ])
      await database.insert(trips).values([
        trip(vehicleId, '2026-01-10T07:00:00.000Z', 100, 6),
        trip(vehicleId, '2026-01-22T07:00:00.000Z', 200, 12),
        trip(vehicleId, '2026-02-12T07:00:00.000Z', 250, 15)
      ])
      await database.insert(refuelEvents).values([
        { vehicleId, detectedAt: new Date('2026-01-20T10:00:00.000Z'), litresAdded: 30, pricePerLitre: 60, totalAmount: 1800 },
        { vehicleId, detectedAt: new Date('2026-02-10T10:00:00.000Z'), litresAdded: 40, pricePerLitre: 65, totalAmount: 2600 }
      ])

      const { months, currentMonth } = await monthlyTrends(database, now)
      expect(currentMonth).toBe('2026-03')
      expect(months.map(item => item.month)).toEqual(['2026-01', '2026-02', '2026-03'])

      const [january, february, march] = months
      // 40 л в баке плюс 30 залитых минус 20 оставшихся — из бака, а не из суммы
      // поездок, где потерялись прогревы.
      expect(january!.fuelUsed).toBeCloseTo(50)
      expect(january!.fuelSource).toBe('balance')
      expect(january!.distance).toBe(300)
      expect(january!.trips).toBe(2)
      expect(january!.spend).toBe(1800)
      expect(january!.pricePerLitre).toBeCloseTo(60)
      expect(january!.costPerKm).toBeCloseTo(50 * 60 / 300)

      // Февраль начинается с того уровня, на котором кончился январь, а не с
      // первого своего показания: между ними ничего не потерялось.
      expect(february!.fuelUsed).toBeCloseTo(30)
      expect(february!.consumption).toBeCloseTo(12)
      expect(february!.costPerKm).toBeCloseTo(30 * 65 / 250)

      // Месяц, до которого машина ещё не доехала, остаётся пустым, а не
      // придуманным.
      expect(march!.distance).toBe(0)
      expect(march!.consumption).toBeNull()
      expect(march!.spend).toBeNull()
      expect(march!.costPerKm).toBeNull()
    } finally {
      await database.$client.close()
    }
  })

  it('оставляет месяц без чеков без цены литра, но с ценой километра', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values([
        reading(vehicleId, '2026-01-05T09:00:00.000Z', 40),
        reading(vehicleId, '2026-01-28T18:00:00.000Z', 30),
        reading(vehicleId, '2026-02-03T09:00:00.000Z', 30),
        reading(vehicleId, '2026-02-25T18:00:00.000Z', 20)
      ])
      await database.insert(trips).values([
        trip(vehicleId, '2026-01-10T07:00:00.000Z', 100, 6),
        trip(vehicleId, '2026-02-12T07:00:00.000Z', 100, 6)
      ])
      await database.insert(refuelEvents).values([
        { vehicleId, detectedAt: new Date('2026-01-20T10:00:00.000Z'), litresAdded: 20, pricePerLitre: 60, totalAmount: 1200 }
      ])

      const { months } = await monthlyTrends(database, now)
      const february = months.find(item => item.month === '2026-02')!
      expect(february.spend).toBeNull()
      expect(february.pricePerLitre).toBeNull()
      // Заправок в феврале не было, а бензин расходовался: километр считается по
      // последней известной цене — ровно как на карточке месяца.
      expect(february.fuelUsed).toBeCloseTo(10)
      expect(february.costPerKm).toBeCloseTo(10 * 60 / 100)
    } finally {
      await database.$client.close()
    }
  })

  it('не считает бак по балансу, когда у заправки неизвестен объём', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values([
        reading(vehicleId, '2026-02-03T09:00:00.000Z', 30),
        reading(vehicleId, '2026-02-25T18:00:00.000Z', 20)
      ])
      await database.insert(trips).values([trip(vehicleId, '2026-02-12T07:00:00.000Z', 100, 6)])
      await database.insert(refuelEvents).values([
        { vehicleId, detectedAt: new Date('2026-02-10T10:00:00.000Z'), totalAmount: 1500 }
      ])

      const { months } = await monthlyTrends(database, now)
      const february = months.find(item => item.month === '2026-02')!
      expect(february.fuelSource).toBe('trips')
      expect(february.fuelUsed).toBeCloseTo(6)
      expect(february.spend).toBe(1500)
      // Литров у заправки нет, делить сумму не на что.
      expect(february.pricePerLitre).toBeNull()
      expect(february.unpaidRefuels).toBe(0)
    } finally {
      await database.$client.close()
    }
  })
})
