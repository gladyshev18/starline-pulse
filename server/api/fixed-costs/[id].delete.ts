import { and, eq } from 'drizzle-orm'
import { fixedCosts } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор записи' })
  }

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  const where = and(eq(fixedCosts.id, id), eq(fixedCosts.vehicleId, vehicle.id))
  const [existing] = await database.select().from(fixedCosts).where(where).limit(1)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Запись не найдена' })

  await database.delete(fixedCosts).where(where)
  return { id }
})
