import { eq } from 'drizzle-orm'
import { refuelEvents, refuelReceipts } from '../../../../db/schema'
import { linkReceiptToRefuel, rejectReceiptMatch, runReceiptMatch } from '../../../../receipts/store'
import { receiptId, requireVehicle } from '../../../utils/receipts'

const actions = ['link', 'reject', 'rematch', 'create-refuel'] as const
type Action = (typeof actions)[number]

export default defineEventHandler(async (event) => {
  const id = receiptId(event)
  const body = await readBody<{ action?: unknown, refuelEventId?: unknown }>(event) || {}
  const action = String(body.action || 'link') as Action
  if (!actions.includes(action)) throw createError({ statusCode: 400, statusMessage: 'Неизвестное действие' })

  const database = useAppDatabase()
  const [receipt] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, id)).limit(1)
  if (!receipt) throw createError({ statusCode: 404, statusMessage: 'Чек не найден' })

  if (action === 'reject') return { receipt: await rejectReceiptMatch(database, id) }

  if (action === 'rematch') {
    const vehicle = await requireVehicle()
    const reset = await database.update(refuelReceipts)
      .set({ matchStatus: 'unmatched', refuelEventId: null, suggestedRefuelEventId: null, updatedAt: new Date() })
      .where(eq(refuelReceipts.id, id)).returning()
    const match = await runReceiptMatch(database, reset[0]!, vehicle.id)
    const [result] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, id)).limit(1)
    return { receipt: result, match }
  }

  if (action === 'create-refuel') {
    if (!receipt.purchasedAt) throw createError({ statusCode: 400, statusMessage: 'У чека нет даты — заправку не создать' })
    const vehicle = await requireVehicle()
    const [created] = await database.insert(refuelEvents).values({
      vehicleId: vehicle.id,
      detectedAt: receipt.purchasedAt,
      litresAdded: receipt.litres,
      station: receipt.station,
      stationName: receipt.stationName,
      fuelType: receipt.fuelType,
      pricePerLitre: receipt.pricePerLitre,
      totalAmount: receipt.totalAmount
    }).onConflictDoNothing().returning()
    if (!created) throw createError({ statusCode: 409, statusMessage: 'Заправка на это время уже существует' })
    return { receipt: await linkReceiptToRefuel(database, id, created.id), refuel: created }
  }

  const refuelEventId = Number(body.refuelEventId ?? receipt.suggestedRefuelEventId)
  if (!Number.isSafeInteger(refuelEventId) || refuelEventId < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Выберите заправку' })
  }
  const [refuel] = await database.select({ id: refuelEvents.id }).from(refuelEvents)
    .where(eq(refuelEvents.id, refuelEventId)).limit(1)
  if (!refuel) throw createError({ statusCode: 404, statusMessage: 'Заправка не найдена' })

  return { receipt: await linkReceiptToRefuel(database, id, refuelEventId) }
})
