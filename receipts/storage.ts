import { createHash, randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'

export const MAX_RECEIPT_SIZE = 15 * 1024 * 1024

const receiptTypes: Record<string, { mimeType: string, kind: 'image' | 'pdf' | 'html' }> = {
  '.jpg': { mimeType: 'image/jpeg', kind: 'image' },
  '.jpeg': { mimeType: 'image/jpeg', kind: 'image' },
  '.png': { mimeType: 'image/png', kind: 'image' },
  '.gif': { mimeType: 'image/gif', kind: 'image' },
  '.webp': { mimeType: 'image/webp', kind: 'image' },
  '.avif': { mimeType: 'image/avif', kind: 'image' },
  '.heic': { mimeType: 'image/heic', kind: 'image' },
  '.heif': { mimeType: 'image/heif', kind: 'image' },
  '.pdf': { mimeType: 'application/pdf', kind: 'pdf' },
  '.html': { mimeType: 'text/html', kind: 'html' },
  '.htm': { mimeType: 'text/html', kind: 'html' }
}

const extensionsByMimeType: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'text/html': '.html'
}

export type ReceiptFileType = (typeof receiptTypes)[string]

export function detectReceiptType(fileName: string, declaredMimeType?: string) {
  const extension = extname(fileName).toLowerCase()
  const type = receiptTypes[extension]
  if (!type) throw new Error('UNSUPPORTED_RECEIPT_TYPE')

  const declared = declaredMimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (declared && declared !== 'application/octet-stream') {
    if (declared !== type.mimeType) throw new Error('RECEIPT_MIME_MISMATCH')
  }

  return { extension, ...type }
}

export function normalizeReceiptFileName(fileName: string) {
  const normalized = basename(fileName.replaceAll('\\', '/')).replace(/\p{Cc}/gu, '').trim()
  return normalized.slice(0, 240) || 'receipt'
}

// Mail attachments and Telegram photos often arrive with a generic or missing
// file name, so the extension is recovered from the declared MIME type instead.
export function receiptFileNameFor(fileName: string | null | undefined, declaredMimeType?: string) {
  const candidate = fileName ? normalizeReceiptFileName(fileName) : ''
  if (candidate && receiptTypes[extname(candidate).toLowerCase()]) return candidate

  const mimeType = declaredMimeType?.split(';', 1)[0]?.trim().toLowerCase() || ''
  const extension = extensionsByMimeType[mimeType]
  if (!extension) throw new Error('UNSUPPORTED_RECEIPT_TYPE')
  const base = candidate.replace(/\.[^.]*$/, '') || 'receipt'
  return `${base}${extension}`
}

export function getReceiptStorageDir() {
  return process.env.RECEIPT_STORAGE_DIR || resolve(process.cwd(), 'data/refuel-receipts')
}

export function resolveReceiptPath(storedName: string, storageDir = getReceiptStorageDir()) {
  if (!storedName || basename(storedName) !== storedName) throw new Error('INVALID_STORED_NAME')
  const root = resolve(storageDir)
  const filePath = resolve(root, storedName)
  if (!filePath.startsWith(`${root}${sep}`)) throw new Error('INVALID_STORED_NAME')
  return filePath
}

export function receiptContentHash(data: Buffer) {
  return createHash('sha256').update(data).digest('hex')
}

export async function saveReceiptFile(input: {
  data: Buffer
  originalName: string
  declaredMimeType?: string
  storageDir?: string
}) {
  if (!input.data.length) throw new Error('EMPTY_RECEIPT_FILE')
  if (input.data.length > MAX_RECEIPT_SIZE) throw new Error('RECEIPT_TOO_LARGE')

  const originalName = normalizeReceiptFileName(input.originalName)
  const type = detectReceiptType(originalName, input.declaredMimeType)
  const storedName = `${randomUUID()}${type.extension}`
  const storageDir = input.storageDir || getReceiptStorageDir()
  await mkdir(storageDir, { recursive: true })
  await writeFile(resolveReceiptPath(storedName, storageDir), input.data, { flag: 'wx' })

  return {
    originalName,
    storedName,
    mimeType: type.mimeType,
    size: input.data.length,
    contentHash: receiptContentHash(input.data)
  }
}

export async function removeReceiptFile(storedName: string, storageDir?: string) {
  await unlink(resolveReceiptPath(storedName, storageDir)).catch(() => undefined)
}
