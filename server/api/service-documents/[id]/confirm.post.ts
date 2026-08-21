import { and, desc, eq, isNotNull, lt } from 'drizzle-orm'
import { serviceDocuments, serviceEvents, vehicleSnapshots } from '../../../../db/schema'
import { applyConfirmedAct } from '../../../../receipts/service-documents'

function optionalNumber(value: unknown, field: string, maximum: number) {
  if (value == null || value === '') return null
  const result = typeof value === 'number' ? value : Number(String(value).replace(',', '.').replace(/\s/g, ''))
  if (!Number.isFinite(result) || result < 0 || result > maximum) {
    throw createError({ statusCode: 400, statusMessage: `Укажите корректное значение поля «${field}»` })
  }
  return Math.round(result * 100) / 100
}

function optionalText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

function requiredDate(value: unknown) {
  if (value == null || value === '') throw createError({ statusCode: 400, statusMessage: 'Укажите дату работ' })
  // A bare date means that calendar day; midday Moscow keeps it that day for any
  // reader, however their clock is set.
  const raw = String(value)
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00+03:00`)
    : new Date(raw)
  if (Number.isNaN(parsed.getTime())) throw createError({ statusCode: 400, statusMessage: 'Укажите корректную дату работ' })
  if (parsed.getTime() > Date.now() + 24 * 60 * 60_000) {
    throw createError({ statusCode: 400, statusMessage: 'Дата работ не может быть в будущем' })
  }
  return parsed
}

export default defineEventHandler(async (event) => {
  const id = Number.parseInt(getRouterParam(event, 'id') || '', 10)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор документа' })
  }

  const body = await readBody<Record<string, unknown>>(event)
  const performedAt = requiredDate(body?.performedAt)
  const mileage = optionalNumber(body?.mileage, 'Пробег', 2_000_000)
  const totalAmount = optionalNumber(body?.totalAmount, 'Сумма', 10_000_000)
  const vendor = optionalText(body?.vendor, 120)
  const orderNumber = optionalText(body?.orderNumber, 60)
  const note = optionalText(body?.note, 300)
  const createOilEvent = body?.createOilEvent === true

  const database = useAppDatabase()
  const document = await database.query.serviceDocuments.findFirst({ where: eq(serviceDocuments.id, id) })
  if (!document) throw createError({ statusCode: 404, statusMessage: 'Документ не найден' })

  const vehicle = await database.query.vehicles.findFirst()
  if (createOilEvent && !vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  let serviceEventId = document.serviceEventId ?? null
  if (createOilEvent && vehicle) {
    // The engine-hour counter is read as it stood on the day of service, not as
    // it stands now: an act confirmed a month late must not hand that month to
    // the fresh oil.
    const reading = await database.query.vehicleSnapshots.findFirst({
      columns: { motorMinutes: true },
      where: and(
        eq(vehicleSnapshots.vehicleId, vehicle.id),
        isNotNull(vehicleSnapshots.motorMinutes),
        lt(vehicleSnapshots.ts, new Date(performedAt.getTime() + 24 * 60 * 60_000))
      ),
      orderBy: desc(vehicleSnapshots.ts)
    })

    const values = {
      vehicleId: vehicle.id,
      kind: 'oil' as const,
      performedAt,
      mileage,
      motorMinutes: reading?.motorMinutes ?? null,
      note: note ?? (orderNumber ? `Заказ-наряд ${orderNumber}` : null)
    }
    if (serviceEventId) {
      await database.update(serviceEvents).set(values).where(eq(serviceEvents.id, serviceEventId))
    } else {
      const [created] = await database.insert(serviceEvents).values(values).returning()
      serviceEventId = created?.id ?? null
    }
  }

  const updated = await applyConfirmedAct(database, id, {
    orderNumber,
    performedAt,
    mileage,
    totalAmount,
    vendor,
    note,
    serviceEventId
  })
  return { document: updated, serviceEventId }
})
