import { describe, expect, it } from 'vitest'
import {
  detectReceiptType,
  normalizeReceiptFileName,
  receiptContentHash,
  receiptFileNameFor,
  resolveReceiptPath
} from '../receipts/storage'

describe('refuel receipt files', () => {
  it.each([
    ['receipt.JPG', 'image/jpeg', 'image'],
    ['receipt.pdf', 'application/pdf', 'pdf'],
    ['receipt.html', 'text/html; charset=utf-8', 'html'],
    ['receipt.htm', 'application/octet-stream', 'html']
  ])('accepts %s', (fileName, mimeType, kind) => {
    expect(detectReceiptType(fileName, mimeType)).toMatchObject({ kind })
  })

  it('rejects unsupported file types', () => {
    expect(() => detectReceiptType('receipt.exe', 'application/octet-stream')).toThrow('UNSUPPORTED_RECEIPT_TYPE')
  })

  it('rejects a MIME type that conflicts with the extension', () => {
    expect(() => detectReceiptType('receipt.html', 'image/png')).toThrow('RECEIPT_MIME_MISMATCH')
    expect(() => detectReceiptType('receipt.png', 'image/jpeg')).toThrow('RECEIPT_MIME_MISMATCH')
  })

  it('removes path components and control characters from the original name', () => {
    expect(normalizeReceiptFileName('../mail\\receipt\r\n.pdf')).toBe('receipt.pdf')
  })

  it('does not resolve stored files outside the storage directory', () => {
    expect(() => resolveReceiptPath('../receipt.pdf', 'C:\\receipts')).toThrow('INVALID_STORED_NAME')
  })
})

describe('receiptFileNameFor', () => {
  it('keeps a usable name as it is', () => {
    expect(receiptFileNameFor('чек.pdf', 'application/pdf')).toBe('чек.pdf')
  })

  it('recovers the extension for a Telegram photo without a name', () => {
    expect(receiptFileNameFor(null, 'image/jpeg')).toBe('receipt.jpg')
  })

  it('replaces an extension the storage does not accept', () => {
    expect(receiptFileNameFor('receipt.bin', 'application/pdf')).toBe('receipt.pdf')
  })

  it('refuses a name and a MIME type that both say nothing', () => {
    expect(() => receiptFileNameFor('receipt.bin', 'application/octet-stream')).toThrow('UNSUPPORTED_RECEIPT_TYPE')
  })
})

describe('receiptContentHash', () => {
  it('gives identical attachments the same hash', () => {
    expect(receiptContentHash(Buffer.from('чек'))).toBe(receiptContentHash(Buffer.from('чек')))
    expect(receiptContentHash(Buffer.from('чек'))).not.toBe(receiptContentHash(Buffer.from('счёт')))
  })
})
