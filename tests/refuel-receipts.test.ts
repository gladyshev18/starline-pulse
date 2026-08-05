import { describe, expect, it } from 'vitest'
import { detectReceiptType, normalizeReceiptFileName, resolveReceiptPath } from '../server/utils/refuel-receipts'

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
