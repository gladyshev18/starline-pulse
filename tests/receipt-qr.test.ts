import { toBuffer } from 'qrcode'
import { describe, expect, it } from 'vitest'
import { parseFiscalQr, parseFiscalTimestamp, readReceiptQr } from '../receipts/qr'

describe('parseFiscalTimestamp', () => {
  it('reads the till clock as Moscow time', () => {
    expect(parseFiscalTimestamp('20260814T0730')?.toISOString()).toBe('2026-08-14T04:30:00.000Z')
  })

  it('accepts a stamp with seconds', () => {
    expect(parseFiscalTimestamp('20260814T073045')?.toISOString()).toBe('2026-08-14T04:30:45.000Z')
  })

  it('refuses anything else', () => {
    expect(parseFiscalTimestamp('14.08.2026 07:30')).toBeNull()
  })
})

describe('parseFiscalQr', () => {
  it('pulls the moment and the total out of a fiscal code', () => {
    const parsed = parseFiscalQr('t=20260814T0730&s=2530.00&fn=9960440301234567&i=12345&fp=1234567890&n=1')
    expect(parsed).toMatchObject({
      totalAmount: 2530,
      fiscalDocNumber: '12345',
      fiscalSign: '1234567890',
      fiscalDriveNumber: '9960440301234567'
    })
    expect(parsed?.purchasedAt.toISOString()).toBe('2026-08-14T04:30:00.000Z')
  })

  it('handles a code wrapped in the checking service URL', () => {
    const parsed = parseFiscalQr('https://check.ofd.ru/rec?t=20260814T0730&s=1000.50&fp=99')
    expect(parsed?.totalAmount).toBe(1000.5)
  })

  it('rejects a code without a sum', () => {
    expect(parseFiscalQr('t=20260814T0730&fn=996044')).toBeNull()
  })

  it('rejects a QR code that is not a receipt', () => {
    expect(parseFiscalQr('https://example.com/promo')).toBeNull()
  })
})

describe('readReceiptQr', () => {
  it('decodes a fiscal code from a photographed receipt', async () => {
    const image = await toBuffer('t=20260814T0730&s=2530.00&fn=9960440301234567&i=12345&fp=1234567890&n=1', { scale: 8, margin: 4 })

    const parsed = await readReceiptQr(image)

    expect(parsed?.totalAmount).toBe(2530)
    expect(parsed?.purchasedAt.toISOString()).toBe('2026-08-14T04:30:00.000Z')
  }, 20_000)

  it('returns nothing when the picture holds no code', async () => {
    const blank = await toBuffer('нет чека', { scale: 1, margin: 0 })
    expect(await readReceiptQr(blank)).toBeNull()
  }, 20_000)

  it('survives a file that is not an image at all', async () => {
    expect(await readReceiptQr(Buffer.from('это не картинка'))).toBeNull()
  })
})
