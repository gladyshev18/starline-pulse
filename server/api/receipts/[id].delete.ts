import { eq } from 'drizzle-orm'
import { refuelReceipts } from '../../../db/schema'
import { deleteReceipt } from '../../../receipts/store'
import { receiptId } from '../../utils/receipts'

export default defineEventHandler(async (event) => {
  const id = receiptId(event)
  const database = useAppDatabase()
  const [receipt] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, id)).limit(1)
  if (!receipt) throw createError({ statusCode: 404, statusMessage: 'Чек не найден' })

  await deleteReceipt(database, receipt)
  setResponseStatus(event, 204)
  return null
})
