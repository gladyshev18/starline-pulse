import { eq } from 'drizzle-orm'
import { refuelEvents } from '../../../../db/schema'
import { normalizeReceiptFields } from '../../../../receipts/fields'
import { createReceipt } from '../../../../receipts/store'
import { MAX_RECEIPT_SIZE, removeReceiptFile, saveReceiptFile } from '../../../../receipts/storage'
import { receiptUploadError } from '../../../utils/receipts'

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
  const [refuel] = await database.select().from(refuelEvents)
    .where(eq(refuelEvents.id, refuelEventId)).limit(1)
  if (!refuel) throw createError({ statusCode: 404, statusMessage: 'Заправка не найдена' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(part => part.name === 'file' && part.filename)
  if (!file?.filename) throw createError({ statusCode: 400, statusMessage: 'Выберите файл чека' })

  let saved: Awaited<ReturnType<typeof saveReceiptFile>>
  try {
    saved = await saveReceiptFile({ data: file.data, originalName: file.filename, declaredMimeType: file.type })
  } catch (error) {
    throw receiptUploadError(error)
  }

  try {
    // Uploading on a refuel card is itself the link, so the receipt inherits what
    // the card already knows and skips the matcher.
    const { receipt } = await createReceipt(database, {
      source: 'manual',
      dataSource: 'manual',
      refuelEventId,
      file: saved,
      fields: normalizeReceiptFields({
        purchasedAt: refuel.detectedAt,
        station: refuel.station,
        stationName: refuel.stationName,
        fuelType: refuel.fuelType,
        litres: refuel.litresAdded,
        pricePerLitre: refuel.pricePerLitre,
        totalAmount: refuel.totalAmount
      })
    })
    setResponseStatus(event, 201)
    return receipt
  } catch (error) {
    await removeReceiptFile(saved.storedName)
    throw error
  }
})
