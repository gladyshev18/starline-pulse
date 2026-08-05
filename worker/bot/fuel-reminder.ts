import { desc } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { vehicleSnapshots } from '../../db/schema'
import { nextReportRun } from './reports'

export const LOW_FUEL_THRESHOLD_LITRES = 15

const fuelFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
})

export function nextFuelReminderRun(now = new Date()) {
  return nextReportRun('daily', now)
}

export async function buildFuelReminder(database: Database) {
  const snapshot = await database.query.vehicleSnapshots.findFirst({
    orderBy: desc(vehicleSnapshots.ts)
  })
  if (snapshot?.fuel == null || snapshot.fuel >= LOW_FUEL_THRESHOLD_LITRES) return null

  return `⛽ <b>Пора заправиться</b>\nВ баке осталось ${fuelFormatter.format(snapshot.fuel)} л. Пожалуйста, заправьтесь.`
}
