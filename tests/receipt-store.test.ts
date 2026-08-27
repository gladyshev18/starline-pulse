import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/client'
import { refuelEvents, refuelReceipts, vehicles } from '../db/schema'
import { normalizeReceiptFields } from '../receipts/fields'
import {
  createReceipt,
  deleteReceipt,
  findReceiptByContentHash,
  linkReceiptToRefuel,
  rejectReceiptMatch,
  rematchPendingReceipts
} from '../receipts/store'

const purchasedAt = new Date('2026-08-14T07:30:00.000Z')
const detectedAt = new Date('2026-08-14T09:00:00.000Z')

let database: Database
let vehicleId: number

async function addRefuel(values: { detectedAt: Date, litresAdded: number | null }) {
  const [refuel] = await database.insert(refuelEvents).values({ vehicleId, ...values }).returning()
  return refuel!
}

async function addReceipt(fields: Record<string, unknown>, extra: { source?: 'manual' | 'imap' | 'telegram', refuelEventId?: number } = {}) {
  return createReceipt(database, {
    source: extra.source || 'imap',
    dataSource: 'parsed',
    refuelEventId: extra.refuelEventId ?? null,
    fields: normalizeReceiptFields({ purchasedAt, ...fields })
  })
}

beforeEach(async () => {
  database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  vehicleId = vehicle!.id
})

describe('createReceipt', () => {
  it('links a receipt to the refuel it belongs to', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 40 })
    const { receipt, match } = await addReceipt({ litres: 40.2, totalAmount: 2530 })

    expect(match?.status).toBe('auto')
    expect(receipt).toMatchObject({ refuelEventId: refuel.id, matchStatus: 'auto' })
    expect(receipt.matchScore).toBeGreaterThan(0.8)
  })

  it('keeps a receipt waiting when no refuel is near', async () => {
    await addRefuel({ detectedAt: new Date('2026-08-01T09:00:00.000Z'), litresAdded: 40 })
    const { receipt } = await addReceipt({ litres: 40 })

    expect(receipt).toMatchObject({ matchStatus: 'unmatched', refuelEventId: null, suggestedRefuelEventId: null })
  })

  it('only suggests a refuel when the volumes cannot be compared', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: null })
    const { receipt } = await addReceipt({ totalAmount: 2530 })

    expect(receipt).toMatchObject({ matchStatus: 'suggested', refuelEventId: null, suggestedRefuelEventId: refuel.id })
  })

  it('treats an upload made on a refuel card as a decision', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 40 })
    const { receipt } = await addReceipt({ litres: 5 }, { source: 'manual', refuelEventId: refuel.id })

    expect(receipt).toMatchObject({ refuelEventId: refuel.id, matchStatus: 'manual' })
  })
})

describe('rematchPendingReceipts', () => {
  it('links a receipt that arrived before the sensor noticed the refuel', async () => {
    const { receipt } = await addReceipt({ litres: 40, totalAmount: 2530 })
    expect(receipt.matchStatus).toBe('unmatched')

    const refuel = await addRefuel({ detectedAt, litresAdded: 39.6 })
    const linked = await rematchPendingReceipts(database, vehicleId)

    expect(linked.map(item => item.id)).toEqual([receipt.id])
    const stored = await database.query.refuelReceipts.findFirst()
    expect(stored).toMatchObject({ refuelEventId: refuel.id, matchStatus: 'auto' })
  })

  it('leaves a manual link alone', async () => {
    const wrong = await addRefuel({ detectedAt, litresAdded: 40 })
    const other = await addRefuel({ detectedAt: new Date('2026-08-14T08:00:00.000Z'), litresAdded: 12 })
    const { receipt } = await addReceipt({ litres: 12 })
    await linkReceiptToRefuel(database, receipt.id, wrong.id)

    await rematchPendingReceipts(database, vehicleId)

    const stored = await database.query.refuelReceipts.findFirst()
    expect(stored).toMatchObject({ refuelEventId: wrong.id, matchStatus: 'manual' })
    expect(stored?.refuelEventId).not.toBe(other.id)
  })

  it('does not resurrect a rejected receipt', async () => {
    const { receipt } = await addReceipt({ litres: 40 })
    await rejectReceiptMatch(database, receipt.id)
    await addRefuel({ detectedAt, litresAdded: 40 })

    await rematchPendingReceipts(database, vehicleId)

    const stored = await database.query.refuelReceipts.findFirst()
    expect(stored).toMatchObject({ matchStatus: 'rejected', refuelEventId: null })
  })

  it('prefers a refuel that has no receipt yet', async () => {
    const taken = await addRefuel({ detectedAt, litresAdded: 40 })
    const free = await addRefuel({ detectedAt: new Date(detectedAt.getTime() + 60_000), litresAdded: 40 })
    const first = await addReceipt({ litres: 40 })
    await linkReceiptToRefuel(database, first.receipt.id, taken.id)

    const second = await addReceipt({ litres: 40 })
    expect(second.match?.refuelEventId).toBe(free.id)
  })
})

describe('correcting a refuel by its receipt', () => {
  async function refuelById(id: number) {
    const [refuel] = await database.select().from(refuelEvents).where(eq(refuelEvents.id, id)).limit(1)
    return refuel!
  }

  it('replaces the sensor volume with the one the pump actually gave', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 21 })

    await addReceipt({ litres: 20, totalAmount: 1285, pricePerLitre: 64.25 })

    expect(await refuelById(refuel.id)).toMatchObject({
      litresAdded: 20,
      sensorLitresAdded: 21,
      totalAmount: 1285,
      pricePerLitre: 64.25
    })
  })

  it('copies the station and the fuel grade from the receipt', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 21 })

    await addReceipt({ litres: 20, totalAmount: 1285, station: 'rosneft', fuelType: 'АИ-92' })

    expect(await refuelById(refuel.id)).toMatchObject({ station: 'rosneft', fuelType: 'АИ-92' })
  })

  it('gives the sensor reading back when the receipt is rejected', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 21 })
    const { receipt } = await addReceipt({ litres: 20, totalAmount: 1285 })
    expect((await refuelById(refuel.id)).litresAdded).toBe(20)

    await rejectReceiptMatch(database, receipt.id)

    expect(await refuelById(refuel.id)).toMatchObject({ litresAdded: 21, sensorLitresAdded: 21 })
  })

  it('gives the sensor reading back when the receipt is deleted', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 21 })
    const { receipt } = await addReceipt({ litres: 20, totalAmount: 1285 })

    await deleteReceipt(database, (await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, receipt.id)).limit(1))[0]!)

    expect((await refuelById(refuel.id)).litresAdded).toBe(21)
  })

  it('adds up a refuel that was paid with two receipts', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 40 })
    const first = await addReceipt({ litres: 20, totalAmount: 1285 })
    const second = await addReceipt({ litres: 19.5, totalAmount: 1252 })
    await linkReceiptToRefuel(database, first.receipt.id, refuel.id)
    await linkReceiptToRefuel(database, second.receipt.id, refuel.id)

    expect(await refuelById(refuel.id)).toMatchObject({
      litresAdded: 39.5,
      totalAmount: 2537,
      pricePerLitre: 64.23,
      sensorLitresAdded: 40
    })
  })

  it('moves the correction along when the receipt is relinked', async () => {
    const wrong = await addRefuel({ detectedAt, litresAdded: 21 })
    const right = await addRefuel({ detectedAt: new Date(detectedAt.getTime() + 60_000), litresAdded: 30 })
    const { receipt } = await addReceipt({ litres: 20, totalAmount: 1285 })
    await linkReceiptToRefuel(database, receipt.id, wrong.id)

    await linkReceiptToRefuel(database, receipt.id, right.id)

    expect((await refuelById(wrong.id)).litresAdded).toBe(21)
    expect(await refuelById(right.id)).toMatchObject({ litresAdded: 20, sensorLitresAdded: 30 })
  })

  it('subtracts a refund from the refuel the purchase paid for', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 21.93 })
    const purchase = await addReceipt({ litres: 25, totalAmount: 1743.75, pricePerLitre: 69.75, sellerInn: '3664002554' })
    expect(purchase.receipt.refuelEventId).toBe(refuel.id)

    const refund = await addReceipt({
      operation: 'refund',
      purchasedAt: new Date(purchasedAt.getTime() + 3 * 60_000),
      litres: 0.79,
      totalAmount: 55.1,
      pricePerLitre: 69.75,
      sellerInn: '3664002554'
    })

    expect(refund.receipt).toMatchObject({ refuelEventId: refuel.id, matchStatus: 'auto' })
    expect(await refuelById(refuel.id)).toMatchObject({
      litresAdded: 24.21,
      totalAmount: 1688.65,
      pricePerLitre: 69.75,
      sensorLitresAdded: 21.93
    })
  })

  it('keeps a refund waiting while the purchase it reverses is unlinked', async () => {
    const refund = await addReceipt({
      operation: 'refund',
      purchasedAt: new Date(purchasedAt.getTime() + 3 * 60_000),
      litres: 0.79,
      totalAmount: 55.1
    })
    expect(refund.receipt.matchStatus).toBe('unmatched')

    await addReceipt({ litres: 25, totalAmount: 1743.75 })
    const refuel = await addRefuel({ detectedAt, litresAdded: 21.93 })
    await rematchPendingReceipts(database, vehicleId)

    const stored = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, refund.receipt.id)).limit(1)
    expect(stored[0]).toMatchObject({ refuelEventId: refuel.id, matchStatus: 'auto' })
    expect((await refuelById(refuel.id)).litresAdded).toBe(24.21)
  })

  it('takes the refund off the refuel when its purchase is rejected', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 21.93 })
    const purchase = await addReceipt({ litres: 25, totalAmount: 1743.75 })
    await addReceipt({
      operation: 'refund',
      purchasedAt: new Date(purchasedAt.getTime() + 3 * 60_000),
      litres: 0.79,
      totalAmount: 55.1
    })
    expect((await refuelById(refuel.id)).litresAdded).toBe(24.21)

    await rejectReceiptMatch(database, purchase.receipt.id)

    expect((await refuelById(refuel.id)).litresAdded).toBe(21.93)
    const [refund] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.operation, 'refund')).limit(1)
    expect(refund).toMatchObject({ refuelEventId: null, matchStatus: 'unmatched' })
  })

  it('ignores a refund from another seller', async () => {
    const refuel = await addRefuel({ detectedAt, litresAdded: 21.93 })
    await addReceipt({ litres: 25, totalAmount: 1743.75, sellerInn: '3664002554' })
    const refund = await addReceipt({
      operation: 'refund',
      purchasedAt: new Date(purchasedAt.getTime() + 3 * 60_000),
      litres: 0.79,
      totalAmount: 55.1,
      sellerInn: '7707049388'
    })

    expect(refund.receipt).toMatchObject({ refuelEventId: null, matchStatus: 'unmatched' })
    expect((await refuelById(refuel.id)).litresAdded).toBe(25)
  })

  it('leaves an unconfirmed refuel exactly as the sensor reported it', async () => {
    const refuel = await addRefuel({ detectedAt: new Date('2026-07-01T09:00:00.000Z'), litresAdded: 21 })

    await addReceipt({ litres: 20, totalAmount: 1285 })

    expect(await refuelById(refuel.id)).toMatchObject({ litresAdded: 21, totalAmount: null })
  })
})

describe('receipt lookup', () => {
  it('finds an already stored attachment by its content hash', async () => {
    const { receipt } = await createReceipt(database, {
      source: 'imap',
      dataSource: 'parsed',
      fields: normalizeReceiptFields({ purchasedAt, litres: 40 }),
      file: { originalName: 'чек.pdf', storedName: 'a.pdf', mimeType: 'application/pdf', size: 10, contentHash: 'abc' },
      externalMessageId: '<mail-1@ofd>'
    })

    expect(await findReceiptByContentHash(database, 'abc')).toMatchObject({ id: receipt.id })
    expect(await findReceiptByContentHash(database, 'zzz')).toBeNull()
  })
})
