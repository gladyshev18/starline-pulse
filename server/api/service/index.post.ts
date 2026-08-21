import { and, desc, eq, isNotNull, lt } from 'drizzle-orm'
import { serviceEvents, vehicleSnapshots } from '../../../db/schema'

function optionalNumber(value: unknown, field: string, maximum: number) {
  if (value == null || value === '') return null
  const result = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  if (!Number.isFinite(result) || result < 0 || result > maximum) {
    throw createError({ statusCode: 400, statusMessage: `Укажите корректное значение поля «${field}»` })
  }
  return Math.round(result * 10) / 10
}

function performedAt(value: unknown) {
  if (value == null || value === '') return new Date()
  const result = new Date(String(value))
  if (Number.isNaN(result.getTime())) throw createError({ statusCode: 400, statusMessage: 'Укажите корректную дату замены' })
  if (result.getTime() > Date.now() + 24 * 60 * 60_000) {
    throw createError({ statusCode: 400, statusMessage: 'Дата замены не может быть в будущем' })
  }
  return result
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ performedAt?: unknown, mileage?: unknown, note?: unknown }>(event)
  const when = performedAt(body?.performedAt)
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  // Both readings are taken as they stood at the moment of service, not as they
  // stand now: a change recorded a week late must not swallow that week.
  const reading = await database.query.vehicleSnapshots.findFirst({
    columns: { mileage: true, motorMinutes: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicle.id),
      isNotNull(vehicleSnapshots.mileage),
      lt(vehicleSnapshots.ts, new Date(when.getTime() + 24 * 60 * 60_000))
    ),
    orderBy: desc(vehicleSnapshots.ts)
  })
  const mileage = optionalNumber(body?.mileage, 'Пробег', 2_000_000) ?? reading?.mileage ?? null

  const [created] = await database.insert(serviceEvents).values({
    vehicleId: vehicle.id,
    kind: 'oil',
    performedAt: when,
    mileage,
    motorMinutes: reading?.motorMinutes ?? null,
    note
  }).returning()
  return created
})
