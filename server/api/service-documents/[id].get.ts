import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { serviceDocuments } from '../../../db/schema'
import { getServiceDocumentStorageDir } from '../../../receipts/service-documents'
import { resolveReceiptPath } from '../../../receipts/storage'

export default defineEventHandler(async (event) => {
  const id = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор документа' })

  const database = useAppDatabase()
  const [document] = await database.select().from(serviceDocuments).where(eq(serviceDocuments.id, id)).limit(1)
  if (!document) throw createError({ statusCode: 404, statusMessage: 'Документ не найден' })
  if (!document.storedName || !document.mimeType) {
    throw createError({ statusCode: 404, statusMessage: 'У документа нет файла' })
  }

  let path: string
  let fileSize: number
  try {
    path = resolveReceiptPath(document.storedName, getServiceDocumentStorageDir())
    fileSize = (await stat(path)).size
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Файл документа не найден' })
  }

  const originalName = document.originalName || 'document'
  const fallbackExtension = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : ''
  setResponseHeader(event, 'Content-Type', document.mimeType)
  setResponseHeader(event, 'Content-Length', fileSize)
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="document${fallbackExtension}"; filename*=UTF-8''${encodeURIComponent(originalName)}`)
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Content-Security-Policy', "sandbox; default-src 'none'")
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600')
  return sendStream(event, createReadStream(path))
})
