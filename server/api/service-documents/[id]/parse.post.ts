import { eq } from 'drizzle-orm'
import { serviceDocuments } from '../../../../db/schema'
import { scheduleActParse } from '../../../../receipts/act-job'

export default defineEventHandler(async (event) => {
  const id = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор документа' })
  }

  const database = useAppDatabase()
  const document = await database.query.serviceDocuments.findFirst({ where: eq(serviceDocuments.id, id) })
  if (!document) throw createError({ statusCode: 404, statusMessage: 'Документ не найден' })
  if (!document.storedName) throw createError({ statusCode: 400, statusMessage: 'У документа нет файла' })

  // The web process never runs Tesseract itself: recognition takes about a minute
  // and belongs to the worker, same as every other slow thing here.
  await scheduleActParse(database, id)
  return { id, queued: true }
})
