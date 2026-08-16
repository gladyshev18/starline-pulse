// Russian fiscal receipts carry a QR code shaped like
// t=20260814T0730&s=2530.00&fn=9960440301234567&i=12345&fp=1234567890&n=1
// It holds the moment and the total — never the litres or the fuel grade, which
// stay a question for the person who sent the photo.
const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

export type FiscalReceipt = {
  purchasedAt: Date
  totalAmount: number
  fiscalDocNumber: string | null
  fiscalSign: string | null
  fiscalDriveNumber: string | null
}

export function parseFiscalTimestamp(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const moment = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second || 0))
  // The till prints its own local time, which for this car is always Moscow.
  const purchasedAt = new Date(moment - MOSCOW_OFFSET_MS)
  return Number.isNaN(purchasedAt.getTime()) ? null : purchasedAt
}

export function parseFiscalQr(value: string): FiscalReceipt | null {
  if (!value || value.length > 400) return null
  // Some tills encode the checking service URL and hang the fiscal fields off
  // its query string instead of emitting the bare parameters.
  const query = value.trim().split('?').at(-1) || ''
  const params = new URLSearchParams(query)
  const time = params.get('t')
  const sum = params.get('s')
  if (!time || !sum) return null

  const purchasedAt = parseFiscalTimestamp(time)
  const totalAmount = Number(sum.replace(',', '.'))
  if (!purchasedAt || !Number.isFinite(totalAmount) || totalAmount <= 0) return null

  return {
    purchasedAt,
    totalAmount: Math.round(totalAmount * 100) / 100,
    fiscalDocNumber: params.get('i'),
    fiscalSign: params.get('fp'),
    fiscalDriveNumber: params.get('fn')
  }
}

export async function readReceiptQr(data: Buffer): Promise<FiscalReceipt | null> {
  const { Jimp } = await import('jimp')
  const jsQR = (await import('jsqr')).default

  let image
  try {
    image = await Jimp.read(data)
  } catch {
    return null
  }

  // A phone photo is far larger than the decoder needs, and shrinking it keeps
  // the scan quick; a second pass in greyscale rescues dim or glossy paper.
  if (image.bitmap.width > 1400) image.resize({ w: 1400 })
  const attempts = [image, image.clone().greyscale().contrast(0.3)]
  for (const attempt of attempts) {
    const { data: pixels, width, height } = attempt.bitmap
    const found = jsQR(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height)
    const parsed = found?.data ? parseFiscalQr(found.data) : null
    if (parsed) return parsed
  }
  return null
}
