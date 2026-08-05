import { and, eq } from 'drizzle-orm'
import { trips } from '../../../db/schema'

const MAX_COMMENT_LENGTH = 1000

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор поездки' })
  }

  const body = await readBody<{ comment?: unknown }>(event)
  if (typeof body?.comment !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Комментарий должен быть строкой' })
  }

  const comment = body.comment.trim()
  if (comment.length > MAX_COMMENT_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `Комментарий не должен превышать ${MAX_COMMENT_LENGTH} символов` })
  }

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  const where = and(eq(trips.id, id), eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false))
  const [trip] = await database.select({ id: trips.id }).from(trips).where(where).limit(1)
  if (!trip) throw createError({ statusCode: 404, statusMessage: 'Завершённая поездка не найдена' })

  await database.update(trips).set({ comment: comment || null }).where(where)
  return { id, comment: comment || null }
})
