import { eq } from 'drizzle-orm'
import { refuelReceipts } from '../../../db/schema'
import { applyReceiptsToRefuel, runReceiptMatch } from '../../../receipts/store'
import { receiptFieldsFrom, receiptId, requireVehicle } from '../../utils/receipts'

export default defineEventHandler(async (event) => {
  const id = receiptId(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  const fields = receiptFieldsFrom(body)

  const database = useAppDatabase()
  const [receipt] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, id)).limit(1)
  if (!receipt) throw createError({ statusCode: 404, statusMessage: 'Чек не найден' })

  const [updated] = await database.update(refuelReceipts).set({
    ...fields,
    dataSource: 'manual',
    // Corrected figures invalidate an automatic verdict, but never a decision a
    // person already made about this receipt.
    pendingField: null,
    updatedAt: new Date()
  }).where(eq(refuelReceipts.id, id)).returning()
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Чек не найден' })

  const vehicle = await requireVehicle()
  const match = await runReceiptMatch(database, updated, vehicle.id)
  const [result] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, id)).limit(1)
  // Edited figures are the corrected truth for the refuel they confirm.
  await applyReceiptsToRefuel(database, result?.refuelEventId ?? null)
  return { receipt: result || updated, match }
})
