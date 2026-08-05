import { eq } from 'drizzle-orm'
import { refuelEvents, refuelReceipts } from '../../../../db/schema'
import { MAX_RECEIPT_SIZE, removeReceiptFile, saveReceiptFile } from '../../../utils/refuel-receipts'

function uploadError(error: unknown) {
  const code = error instanceof Error ? error.message : ''
  if (code === 'RECEIPT_TOO_LARGE') return createError({ statusCode: 413, statusMessage: 'Файл чека больше 15 МБ' })
  if (code === 'EMPTY_RECEIPT_FILE') return createError({ statusCode: 400, statusMessage: 'Файл чека пуст' })
  if (code === 'UNSUPPORTED_RECEIPT_TYPE' || code === 'RECEIPT_MIME_MISMATCH') {
    return createError({ statusCode: 415, statusMessage: 'Поддерживаются изображения, PDF и HTML' })
  }
  return error
}

export default defineEventHandler(async (event) => {
  const refuelEventId = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(refuelEventId) || refuelEventId < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор заправки' })
  }

  const contentLength = Number.parseInt(getHeader(event, 'content-length') || '0', 10)
  if (contentLength > MAX_RECEIPT_SIZE + 1024 * 1024) {
    throw createError({ statusCode: 413, statusMessage: 'Файл чека больше 15 МБ' })
  }

  const database = useAppDatabase()
  const refuel = await database.select({ id: refuelEvents.id }).from(refuelEvents)
    .where(eq(refuelEvents.id, refuelEventId)).limit(1)
  if (!refuel.length) throw createError({ statusCode: 404, statusMessage: 'Заправка не найдена' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(part => part.name === 'file' && part.filename)
  if (!file?.filename) throw createError({ statusCode: 400, statusMessage: 'Выберите файл чека' })

  let saved: Awaited<ReturnType<typeof saveReceiptFile>>
  try {
    saved = await saveReceiptFile({
      data: file.data,
      originalName: file.filename,
      declaredMimeType: file.type
    })
  } catch (error) {
    throw uploadError(error)
  }

  try {
    const [receipt] = await database.insert(refuelReceipts).values({
      refuelEventId,
      source: 'manual',
      ...saved
    }).returning()
    setResponseStatus(event, 201)
    return receipt
  } catch (error) {
    await removeReceiptFile(saved.storedName)
    throw error
  }
})
