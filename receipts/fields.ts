export const RECEIPT_STATIONS = ['rosneft', 'lukoil', 'other'] as const
export const RECEIPT_PAYMENT_METHODS = ['card', 'cash', 'unknown'] as const

export type ReceiptStation = (typeof RECEIPT_STATIONS)[number]
export type ReceiptPaymentMethod = (typeof RECEIPT_PAYMENT_METHODS)[number]

export type ReceiptFields = {
  purchasedAt: Date | null
  station: ReceiptStation | null
  stationName: string | null
  address: string | null
  fuelType: string | null
  litres: number | null
  pricePerLitre: number | null
  totalAmount: number | null
  paymentMethod: ReceiptPaymentMethod
  fiscalDocNumber: string | null
  fiscalSign: string | null
  sellerInn: string | null
}

export class ReceiptFieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReceiptFieldError'
  }
}

const LIMITS = {
  litres: 200,
  pricePerLitre: 10_000,
  totalAmount: 10_000_000
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new ReceiptFieldError(`Поле «${field}» должно быть текстом`)
  const result = value.trim()
  if (!result) return null
  if (result.length > maxLength) throw new ReceiptFieldError(`Поле «${field}» не должно превышать ${maxLength} символов`)
  return result
}

function optionalAmount(value: unknown, field: string, maximum: number) {
  if (value == null || value === '') return null
  const result = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  if (!Number.isFinite(result) || result <= 0 || result > maximum) {
    throw new ReceiptFieldError(`Укажите корректное значение поля «${field}»`)
  }
  return Math.round(result * 100) / 100
}

function optionalDate(value: unknown, field: string) {
  if (value == null || value === '') return null
  const result = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(result.getTime())) throw new ReceiptFieldError(`Укажите корректное значение поля «${field}»`)
  const year = result.getUTCFullYear()
  if (year < 2000 || year > 2100) throw new ReceiptFieldError(`Укажите корректное значение поля «${field}»`)
  return result
}

function station(value: unknown): ReceiptStation | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !RECEIPT_STATIONS.includes(value as ReceiptStation)) {
    throw new ReceiptFieldError('Выберите АЗС')
  }
  return value as ReceiptStation
}

function paymentMethod(value: unknown): ReceiptPaymentMethod {
  if (value == null || value === '') return 'unknown'
  if (typeof value !== 'string' || !RECEIPT_PAYMENT_METHODS.includes(value as ReceiptPaymentMethod)) {
    throw new ReceiptFieldError('Выберите способ оплаты')
  }
  return value as ReceiptPaymentMethod
}

export function normalizeReceiptFields(input: Record<string, unknown>): ReceiptFields {
  const values: ReceiptFields = {
    purchasedAt: optionalDate(input.purchasedAt, 'Дата и время'),
    station: station(input.station),
    stationName: optionalText(input.stationName, 'Название АЗС', 100),
    address: optionalText(input.address, 'Адрес', 250),
    fuelType: optionalText(input.fuelType, 'Вид топлива', 50),
    litres: optionalAmount(input.litres, 'Объём', LIMITS.litres),
    pricePerLitre: optionalAmount(input.pricePerLitre, 'Цена за литр', LIMITS.pricePerLitre),
    totalAmount: optionalAmount(input.totalAmount, 'Сумма', LIMITS.totalAmount),
    paymentMethod: paymentMethod(input.paymentMethod),
    fiscalDocNumber: optionalText(input.fiscalDocNumber, 'Номер документа', 40),
    fiscalSign: optionalText(input.fiscalSign, 'Фискальный признак', 40),
    sellerInn: optionalText(input.sellerInn, 'ИНН', 20)
  }
  if (values.station === 'other' && !values.stationName) {
    throw new ReceiptFieldError('Укажите название АЗС')
  }
  return completeReceiptAmounts(values)
}

// A QR code carries only the total, and a paper receipt sometimes shows just the
// litres and the price. Any two of the three values give the third.
export function completeReceiptAmounts<T extends Pick<ReceiptFields, 'litres' | 'pricePerLitre' | 'totalAmount'>>(values: T): T {
  const round = (value: number) => Math.round(value * 100) / 100
  if (values.litres != null && values.pricePerLitre != null && values.totalAmount == null) {
    values.totalAmount = round(values.litres * values.pricePerLitre)
  } else if (values.totalAmount != null && values.pricePerLitre != null && values.litres == null) {
    values.litres = round(values.totalAmount / values.pricePerLitre)
  } else if (values.totalAmount != null && values.litres != null && values.pricePerLitre == null) {
    values.pricePerLitre = round(values.totalAmount / values.litres)
  }
  return values
}

export function receiptHasFigures(values: Pick<ReceiptFields, 'litres' | 'totalAmount' | 'purchasedAt'>) {
  return values.purchasedAt != null && (values.litres != null || values.totalAmount != null)
}

// Answers typed into Telegram arrive as "38,4", "38.4" or "2 530".
export function parseNumericAnswer(text: string) {
  const value = Number(text.replace(',', '.').replace(/[\s ]/g, ''))
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null
}

export function missingReceiptField(values: Pick<ReceiptFields, 'litres' | 'pricePerLitre' | 'totalAmount'>) {
  if (values.litres == null) return 'litres' as const
  if (values.totalAmount == null) return 'totalAmount' as const
  return null
}
