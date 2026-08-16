import { ReceiptFieldError, normalizeReceiptFields } from '../../receipts/fields'

export function receiptFieldsFrom(body: Record<string, unknown>) {
  try {
    return normalizeReceiptFields(body)
  } catch (error) {
    if (error instanceof ReceiptFieldError) throw createError({ statusCode: 400, statusMessage: error.message })
    throw error
  }
}

export function receiptUploadError(error: unknown) {
  const code = error instanceof Error ? error.message : ''
  if (code === 'RECEIPT_TOO_LARGE') return createError({ statusCode: 413, statusMessage: 'Файл чека больше 15 МБ' })
  if (code === 'EMPTY_RECEIPT_FILE') return createError({ statusCode: 400, statusMessage: 'Файл чека пуст' })
  if (code === 'UNSUPPORTED_RECEIPT_TYPE' || code === 'RECEIPT_MIME_MISMATCH') {
    return createError({ statusCode: 415, statusMessage: 'Поддерживаются изображения, PDF и HTML' })
  }
  return error
}

export function receiptId(event: Parameters<typeof getRouterParam>[0]) {
  const id = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор чека' })
  return id
}

export async function requireVehicle() {
  const vehicle = await useAppDatabase().query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })
  return vehicle
}
