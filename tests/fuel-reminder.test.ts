import { migrate } from 'drizzle-orm/libsql/migrator'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { vehicles, vehicleSnapshots } from '../db/schema'
import { buildFuelReminder, LOW_FUEL_THRESHOLD_LITRES, nextFuelReminderRun } from '../worker/bot/fuel-reminder'

describe('daily low-fuel reminder', () => {
  it('runs every day at 15:00 Moscow time', () => {
    expect(nextFuelReminderRun(new Date('2026-08-05T11:00:00.000Z')).toISOString()).toBe('2026-08-05T12:00:00.000Z')
    expect(nextFuelReminderRun(new Date('2026-08-05T13:00:00.000Z')).toISOString()).toBe('2026-08-06T12:00:00.000Z')
  })

  it('asks to refuel when the latest reading is below 15 litres', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    await database.insert(vehicleSnapshots).values({
      vehicleId: vehicle.id,
      ts: new Date('2026-08-05T05:00:00.000Z'),
      fuel: 14.9,
      rawJson: '{}'
    })

    try {
      expect(LOW_FUEL_THRESHOLD_LITRES).toBe(15)
      await expect(buildFuelReminder(database)).resolves.toContain('В баке осталось 14,9 л')
      await expect(buildFuelReminder(database)).resolves.toContain('Пожалуйста, заправьтесь')
    } finally {
      await database.$client.close()
    }
  })

  it.each([15, 15.1])('does not remind at %s litres', async fuel => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    await database.insert(vehicleSnapshots).values({ vehicleId: vehicle.id, ts: new Date(), fuel, rawJson: '{}' })

    try {
      await expect(buildFuelReminder(database)).resolves.toBeNull()
    } finally {
      await database.$client.close()
    }
  })

  it('does not remind when the fuel reading is unavailable', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })

    try {
      await expect(buildFuelReminder(database)).resolves.toBeNull()
    } finally {
      await database.$client.close()
    }
  })
})
