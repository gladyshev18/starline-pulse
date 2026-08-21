import { deleteServiceDocument } from '../../../receipts/service-documents'

export default defineEventHandler(async (event) => {
  const id = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор документа' })

  const database = useAppDatabase()
  const removed = await deleteServiceDocument(database, id)
  if (!removed) throw createError({ statusCode: 404, statusMessage: 'Документ не найден' })
  return { id }
})
