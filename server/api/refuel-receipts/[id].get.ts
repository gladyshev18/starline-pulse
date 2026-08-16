import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { refuelReceipts } from '../../../db/schema'
import { resolveReceiptPath } from '../../../receipts/storage'

export default defineEventHandler(async (event) => {
  const id = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор чека' })

  const database = useAppDatabase()
  const [receipt] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, id)).limit(1)
  if (!receipt) throw createError({ statusCode: 404, statusMessage: 'Чек не найден' })
  if (!receipt.storedName || !receipt.mimeType) {
    throw createError({ statusCode: 404, statusMessage: 'У чека нет файла' })
  }

  let path: string
  let fileSize: number
  try {
    path = resolveReceiptPath(receipt.storedName)
    fileSize = (await stat(path)).size
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Файл чека не найден' })
  }

  const originalName = receipt.originalName || 'receipt'
  const fallbackExtension = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : ''
  setResponseHeader(event, 'Content-Type', receipt.mimeType)
  setResponseHeader(event, 'Content-Length', fileSize)
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="receipt${fallbackExtension}"; filename*=UTF-8''${encodeURIComponent(originalName)}`)
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Content-Security-Policy', "sandbox; default-src 'none'")
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600')
  return sendStream(event, createReadStream(path))
})
