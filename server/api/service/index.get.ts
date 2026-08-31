import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { fixedCosts, serviceEvents, vehicleSnapshots } from '../../../db/schema'
import { batteryHealth } from '../../../metrics/battery'
import { emptyOilStatus, engineSummary, oilStatus } from '../../../metrics/engine'
import { currentMoscowMonth, moscowMonthRange } from '../../../shared/moscow-month'

export default defineEventHandler(async () => {
  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) {
    return {
      vehicle: null,
      oil: emptyOilStatus(),
      engine: {
        counterMinutes: 0,
        sessionMinutes: 0,
        sessions: 0,
        untrackedIdleMinutes: 0,
        untrackedMovingMinutes: 0,
        untrackedTrips: [] as Awaited<ReturnType<typeof engineSummary>>['untrackedTrips']
      },
      battery: null,
      motorMinutes: null,
      mileage: null,
      events: [],
      fixedCosts: [] as Array<typeof fixedCosts.$inferSelect>
    }
  }

  const now = new Date()
  const month = moscowMonthRange(currentMoscowMonth())!
  // The counter and the odometer refresh on their own schedules, so the latest
  // reading of each is taken separately rather than from one snapshot.
  const [counter, odometer] = await Promise.all([
    database.query.vehicleSnapshots.findFirst({
      columns: { motorMinutes: true },
      where: and(eq(vehicleSnapshots.vehicleId, vehicle.id), isNotNull(vehicleSnapshots.motorMinutes)),
      orderBy: desc(vehicleSnapshots.ts)
    }),
    database.query.vehicleSnapshots.findFirst({
      columns: { mileage: true },
      where: and(eq(vehicleSnapshots.vehicleId, vehicle.id), isNotNull(vehicleSnapshots.mileage)),
      orderBy: desc(vehicleSnapshots.ts)
    })
  ])

  return {
    vehicle,
    oil: await oilStatus(database, vehicle.id, now),
    engine: await engineSummary(database, vehicle.id, month.start, now),
    // Degradation is a matter of years, so the trend is fitted over everything
    // recorded rather than over the month on screen.
    battery: await batteryHealth(database, vehicle.id, new Date(0), now),
    motorMinutes: counter?.motorMinutes ?? null,
    mileage: odometer?.mileage ?? null,
    events: await database.select().from(serviceEvents)
      .where(eq(serviceEvents.vehicleId, vehicle.id))
      .orderBy(desc(serviceEvents.performedAt)),
    // Страховка и налог живут рядом с обслуживанием: и то и другое — деньги за
    // машину, которые никак не следуют из телеметрии и вводятся руками.
    fixedCosts: await database.select().from(fixedCosts)
      .where(eq(fixedCosts.vehicleId, vehicle.id))
      .orderBy(desc(fixedCosts.startsAt))
  }
})
