import { and, eq } from 'drizzle-orm'
import { trips } from '../../../db/schema'

const MAX_COMMENT_LENGTH = 1000
const MAX_DRIVER_LENGTH = 100

// Комментарий и водитель правятся одним запросом, но независимо: страница шлёт
// только то поле, которое меняет, и отсутствие второго не должно его стирать.
function readOptionalText(body: Record<string, unknown>, key: string, maxLength: number, label: string) {
  if (!(key in body)) return undefined
  const value = body[key]
  if (value === null) return null
  if (typeof value !== 'string') {
    throw createError({ statusCode: 400, statusMessage: `${label} должен быть строкой` })
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw createError({ statusCode: 400, statusMessage: `${label} не должен превышать ${maxLength} символов` })
  }
  return trimmed || null
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор поездки' })
  }

  const body = await readBody<Record<string, unknown>>(event) || {}
  const comment = readOptionalText(body, 'comment', MAX_COMMENT_LENGTH, 'Комментарий')
  const driver = readOptionalText(body, 'driver', MAX_DRIVER_LENGTH, 'Имя водителя')
  if (comment === undefined && driver === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Нечего менять: не передан ни комментарий, ни водитель' })
  }

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  const where = and(eq(trips.id, id), eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false))
  const [trip] = await database.select({ id: trips.id }).from(trips).where(where).limit(1)
  if (!trip) throw createError({ statusCode: 404, statusMessage: 'Завершённая поездка не найдена' })

  const [updated] = await database.update(trips).set({
    ...(comment === undefined ? {} : { comment }),
    ...(driver === undefined ? {} : { driver })
  }).where(where).returning({ id: trips.id, comment: trips.comment, driver: trips.driver })
  return updated ?? { id, comment: comment ?? null, driver: driver ?? null }
})
