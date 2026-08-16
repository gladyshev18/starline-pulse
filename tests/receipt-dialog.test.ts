import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/client'
import { refuelEvents, refuelReceipts, vehicles } from '../db/schema'
import { normalizeReceiptFields, parseNumericAnswer } from '../receipts/fields'
import { applyPendingAnswer, createReceipt, findPendingDialogReceipt } from '../receipts/store'

const purchasedAt = new Date('2026-08-14T07:30:00.000Z')
const detectedAt = new Date('2026-08-14T09:00:00.000Z')
const chatId = '100500'

let database: Database
let vehicleId: number

async function askedReceipt(fields: Record<string, unknown>, pendingField: 'litres' | 'totalAmount') {
  const { receipt } = await createReceipt(database, {
    source: 'telegram',
    dataSource: 'qr',
    pendingChatId: chatId,
    fields: normalizeReceiptFields({ purchasedAt, ...fields })
  })
  await database.update(refuelReceipts).set({ pendingField }).where(eq(refuelReceipts.id, receipt.id))
  return (await findPendingDialogReceipt(database, chatId))!
}

beforeEach(async () => {
  database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  vehicleId = vehicle!.id
})

describe('parseNumericAnswer', () => {
  it.each([
    ['38,4', 38.4],
    ['38.4', 38.4],
    ['2 530', 2530],
    ['40', 40]
  ])('reads %s', (text, expected) => {
    expect(parseNumericAnswer(text)).toBe(expected)
  })

  it.each(['сорок', '', '-5', '0'])('refuses %s', (text) => {
    expect(parseNumericAnswer(text)).toBeNull()
  })
})

describe('findPendingDialogReceipt', () => {
  it('ignores a chat with nothing to answer', async () => {
    await createReceipt(database, {
      source: 'telegram',
      dataSource: 'qr',
      pendingChatId: chatId,
      fields: normalizeReceiptFields({ purchasedAt, litres: 40, totalAmount: 2500 })
    })
    expect(await findPendingDialogReceipt(database, chatId)).toBeNull()
  })

  it('finds the receipt waiting for an answer', async () => {
    const receipt = await askedReceipt({ totalAmount: 2530 }, 'litres')
    expect(receipt).toMatchObject({ pendingField: 'litres', pendingChatId: chatId })
  })
})

describe('applyPendingAnswer', () => {
  it('stores the answer, fills the price and links the refuel', async () => {
    const [refuel] = await database.insert(refuelEvents).values({ vehicleId, detectedAt, litresAdded: 39.8 }).returning()
    const receipt = await askedReceipt({ totalAmount: 2530 }, 'litres')

    const updated = await applyPendingAnswer(database, receipt, 40, vehicleId)

    expect(updated).toMatchObject({
      litres: 40,
      totalAmount: 2530,
      pricePerLitre: 63.25,
      pendingField: null,
      matchStatus: 'auto',
      refuelEventId: refuel!.id
    })
  })

  it('keeps waiting when the answer still leaves the receipt short', async () => {
    const receipt = await askedReceipt({}, 'litres')

    const updated = await applyPendingAnswer(database, receipt, 40, vehicleId)

    expect(updated).toMatchObject({ litres: 40, totalAmount: null, pendingField: null })
  })

  it('does nothing when no question is open', async () => {
    const { receipt } = await createReceipt(database, {
      source: 'telegram',
      dataSource: 'qr',
      fields: normalizeReceiptFields({ purchasedAt, litres: 40 })
    })

    expect(await applyPendingAnswer(database, receipt, 99, vehicleId)).toMatchObject({ litres: 40 })
  })
})
