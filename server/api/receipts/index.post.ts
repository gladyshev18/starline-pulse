import { eq } from 'drizzle-orm'
import { refuelEvents } from '../../../db/schema'
import { createReceipt } from '../../../receipts/store'
import { MAX_RECEIPT_SIZE, removeReceiptFile, saveReceiptFile } from '../../../receipts/storage'
import { receiptFieldsFrom, receiptUploadError } from '../../utils/receipts'

type UploadedFile = { data: Buffer, filename: string, type?: string }

async function readInput(event: Parameters<typeof readBody>[0]) {
  const contentType = getHeader(event, 'content-type') || ''
  if (!contentType.includes('multipart/form-data')) {
    const body = await readBody<Record<string, unknown>>(event)
    return { body: body || {}, file: null as UploadedFile | null }
  }

  const parts = await readMultipartFormData(event) || []
  const body: Record<string, unknown> = {}
  let file: UploadedFile | null = null
  for (const part of parts) {
    if (part.name === 'file' && part.filename) file = { data: part.data, filename: part.filename, type: part.type }
    else if (part.name) body[part.name] = part.data.toString('utf8')
  }
  return { body, file }
}

export default defineEventHandler(async (event) => {
  const contentLength = Number.parseInt(getHeader(event, 'content-length') || '0', 10)
  if (contentLength > MAX_RECEIPT_SIZE + 1024 * 1024) {
    throw createError({ statusCode: 413, statusMessage: 'Файл чека больше 15 МБ' })
  }

  const { body, file } = await readInput(event)
  const fields = receiptFieldsFrom(body)
  if (!fields.purchasedAt) throw createError({ statusCode: 400, statusMessage: 'Укажите дату и время чека' })
  if (fields.litres == null && fields.totalAmount == null) {
    throw createError({ statusCode: 400, statusMessage: 'Укажите объём или сумму чека' })
  }

  const database = useAppDatabase()
  let refuelEventId: number | null = null
  if (body.refuelEventId != null && body.refuelEventId !== '') {
    refuelEventId = Number(body.refuelEventId)
    if (!Number.isSafeInteger(refuelEventId) || refuelEventId < 1) {
      throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор заправки' })
    }
    const [refuel] = await database.select({ id: refuelEvents.id }).from(refuelEvents)
      .where(eq(refuelEvents.id, refuelEventId)).limit(1)
    if (!refuel) throw createError({ statusCode: 404, statusMessage: 'Заправка не найдена' })
  }

  let saved: Awaited<ReturnType<typeof saveReceiptFile>> | null = null
  if (file) {
    try {
      saved = await saveReceiptFile({ data: file.data, originalName: file.filename, declaredMimeType: file.type })
    } catch (error) {
      throw receiptUploadError(error)
    }
  }

  try {
    const created = await createReceipt(database, {
      source: 'manual',
      dataSource: 'manual',
      fields,
      file: saved,
      refuelEventId
    })
    setResponseStatus(event, 201)
    return created
  } catch (error) {
    if (saved) await removeReceiptFile(saved.storedName)
    throw error
  }
})
