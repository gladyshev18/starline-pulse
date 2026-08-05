import { eq } from 'drizzle-orm'
import { apiCalls } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const id = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор записи' })

  const item = await useAppDatabase().query.apiCalls.findFirst({ where: eq(apiCalls.id, id) })
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Запись журнала не найдена' })
  return item
})
