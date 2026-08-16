import { and, desc, eq, gte, inArray, isNotNull, lte, or } from 'drizzle-orm'
import type { Database } from '../db/client'
import { refuelEvents, refuelReceipts, type RefuelReceipt } from '../db/schema'
import {
  MATCH_WINDOW_AFTER_MS,
  MATCH_WINDOW_BEFORE_MS,
  matchReceipt,
  type ReceiptMatchResult
} from '../shared/receipt-match'
import { completeReceiptAmounts, type ReceiptFields } from './fields'
import { removeReceiptFile } from './storage'

export type ReceiptFile = {
  originalName: string
  storedName: string
  mimeType: string
  size: number
  contentHash: string
}

export type CreateReceiptInput = {
  source: 'manual' | 'imap' | 'telegram'
  dataSource: 'manual' | 'parsed' | 'qr'
  fields: ReceiptFields
  file?: ReceiptFile | null
  externalMessageId?: string | null
  refuelEventId?: number | null
  pendingChatId?: string | null
}

// A link made by a person, and an explicit rejection, both outrank anything the
// matcher would decide later.
const DECIDED = ['manual', 'rejected'] as const

export function isReceiptConfirming(receipt: Pick<RefuelReceipt, 'matchStatus'>) {
  return receipt.matchStatus === 'auto' || receipt.matchStatus === 'manual'
}

async function refuelIdsWithReceipt(database: Database, refuelEventIds: number[]) {
  if (!refuelEventIds.length) return new Set<number>()
  const rows = await database.select({ refuelEventId: refuelReceipts.refuelEventId })
    .from(refuelReceipts)
    .where(and(
      inArray(refuelReceipts.refuelEventId, refuelEventIds),
      inArray(refuelReceipts.matchStatus, ['auto', 'manual'])
    ))
  return new Set(rows.map(row => row.refuelEventId).filter((id): id is number => id != null))
}

export async function matchCandidatesFor(database: Database, vehicleId: number, purchasedAt: Date) {
  const events = await database.select({
    id: refuelEvents.id,
    detectedAt: refuelEvents.detectedAt,
    litresAdded: refuelEvents.litresAdded,
    percentBefore: refuelEvents.percentBefore,
    percentAfter: refuelEvents.percentAfter
  }).from(refuelEvents).where(and(
    eq(refuelEvents.vehicleId, vehicleId),
    gte(refuelEvents.detectedAt, new Date(purchasedAt.getTime() - MATCH_WINDOW_AFTER_MS)),
    lte(refuelEvents.detectedAt, new Date(purchasedAt.getTime() + MATCH_WINDOW_BEFORE_MS))
  ))

  const occupied = await refuelIdsWithReceipt(database, events.map(event => event.id))
  return events.map(event => ({ ...event, hasReceipt: occupied.has(event.id) }))
}

export async function runReceiptMatch(database: Database, receipt: RefuelReceipt, vehicleId: number): Promise<ReceiptMatchResult> {
  const idle: ReceiptMatchResult = { status: 'unmatched', refuelEventId: null, score: null, candidates: [] }
  if (DECIDED.includes(receipt.matchStatus as (typeof DECIDED)[number])) return idle
  if (!receipt.purchasedAt) return idle

  const result = matchReceipt(
    { purchasedAt: receipt.purchasedAt, litres: receipt.litres },
    await matchCandidatesFor(database, vehicleId, receipt.purchasedAt)
  )

  const now = new Date()
  const previousRefuelEventId = receipt.refuelEventId
  if (result.status === 'auto') {
    await database.update(refuelReceipts).set({
      refuelEventId: result.refuelEventId,
      suggestedRefuelEventId: null,
      matchStatus: 'auto',
      matchScore: result.score,
      matchedAt: now,
      updatedAt: now
    }).where(eq(refuelReceipts.id, receipt.id))
  } else if (result.status === 'suggested') {
    await database.update(refuelReceipts).set({
      refuelEventId: null,
      suggestedRefuelEventId: result.refuelEventId,
      matchStatus: 'suggested',
      matchScore: result.score,
      matchedAt: null,
      updatedAt: now
    }).where(eq(refuelReceipts.id, receipt.id))
  } else {
    await database.update(refuelReceipts).set({
      refuelEventId: null,
      suggestedRefuelEventId: null,
      matchStatus: 'unmatched',
      matchScore: null,
      matchedAt: null,
      updatedAt: now
    }).where(eq(refuelReceipts.id, receipt.id))
  }

  if (previousRefuelEventId != null && previousRefuelEventId !== result.refuelEventId) {
    await applyReceiptsToRefuel(database, previousRefuelEventId)
  }
  if (result.status === 'auto') await applyReceiptsToRefuel(database, result.refuelEventId)
  return result
}

export async function createReceipt(database: Database, input: CreateReceiptInput) {
  const vehicle = await database.query.vehicles.findFirst()
  const linked = input.refuelEventId != null
  const [receipt] = await database.insert(refuelReceipts).values({
    refuelEventId: input.refuelEventId ?? null,
    source: input.source,
    dataSource: input.dataSource,
    matchStatus: linked ? 'manual' : 'unmatched',
    matchedAt: linked ? new Date() : null,
    externalMessageId: input.externalMessageId ?? null,
    pendingChatId: input.pendingChatId ?? null,
    ...input.fields,
    ...(input.file ?? {})
  }).returning()
  if (!receipt) throw new Error('RECEIPT_NOT_CREATED')

  if (linked) {
    await applyReceiptsToRefuel(database, receipt.refuelEventId)
    return { receipt, match: null }
  }
  if (!vehicle) return { receipt, match: null }
  const match = await runReceiptMatch(database, receipt, vehicle.id)
  const [updated] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, receipt.id)).limit(1)
  return { receipt: updated || receipt, match }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

// The receipt is the source of truth: the fuel sensor routinely reports a litre
// more or less than the pump actually gave. The raw reading is kept in
// sensorLitresAdded, so unlinking the receipt restores it.
export async function applyReceiptsToRefuel(database: Database, refuelEventId: number | null) {
  if (refuelEventId == null) return null
  const [refuel] = await database.select().from(refuelEvents).where(eq(refuelEvents.id, refuelEventId)).limit(1)
  if (!refuel) return null

  const attached = (await database.select().from(refuelReceipts)
    .where(eq(refuelReceipts.refuelEventId, refuelEventId))).filter(isReceiptConfirming)

  if (!attached.length) {
    if (refuel.sensorLitresAdded == null || refuel.litresAdded === refuel.sensorLitresAdded) return refuel
    const [restored] = await database.update(refuelEvents)
      .set({ litresAdded: refuel.sensorLitresAdded })
      .where(eq(refuelEvents.id, refuelEventId)).returning()
    return restored || refuel
  }

  // A refuel paid in two transactions carries two receipts, so the figures add up.
  const litres = attached.reduce((total, receipt) => receipt.litres != null ? total + receipt.litres : total, 0)
  const amount = attached.reduce((total, receipt) => receipt.totalAmount != null ? total + receipt.totalAmount : total, 0)
  const priced = attached.find(receipt => receipt.pricePerLitre != null)

  const [updated] = await database.update(refuelEvents).set({
    sensorLitresAdded: refuel.sensorLitresAdded ?? refuel.litresAdded,
    litresAdded: litres > 0 ? round(litres) : refuel.litresAdded,
    totalAmount: amount > 0 ? round(amount) : refuel.totalAmount,
    pricePerLitre: litres > 0 && amount > 0 ? round(amount / litres) : priced?.pricePerLitre ?? refuel.pricePerLitre,
    station: attached.find(receipt => receipt.station != null)?.station ?? refuel.station,
    stationName: attached.find(receipt => receipt.stationName != null)?.stationName ?? refuel.stationName,
    fuelType: attached.find(receipt => receipt.fuelType != null)?.fuelType ?? refuel.fuelType
  }).where(eq(refuelEvents.id, refuelEventId)).returning()
  return updated || refuel
}

export async function linkReceiptToRefuel(database: Database, receiptId: number, refuelEventId: number) {
  const now = new Date()
  const [previous] = await database.select({ refuelEventId: refuelReceipts.refuelEventId })
    .from(refuelReceipts).where(eq(refuelReceipts.id, receiptId)).limit(1)
  const [updated] = await database.update(refuelReceipts).set({
    refuelEventId,
    suggestedRefuelEventId: null,
    matchStatus: 'manual',
    matchedAt: now,
    updatedAt: now
  }).where(eq(refuelReceipts.id, receiptId)).returning()
  if (!updated) return null

  if (previous?.refuelEventId != null && previous.refuelEventId !== refuelEventId) {
    await applyReceiptsToRefuel(database, previous.refuelEventId)
  }
  await applyReceiptsToRefuel(database, refuelEventId)
  return updated
}

export async function rejectReceiptMatch(database: Database, receiptId: number) {
  const now = new Date()
  const [previous] = await database.select({ refuelEventId: refuelReceipts.refuelEventId })
    .from(refuelReceipts).where(eq(refuelReceipts.id, receiptId)).limit(1)
  const [updated] = await database.update(refuelReceipts).set({
    refuelEventId: null,
    suggestedRefuelEventId: null,
    matchStatus: 'rejected',
    matchScore: null,
    matchedAt: null,
    updatedAt: now
  }).where(eq(refuelReceipts.id, receiptId)).returning()
  await applyReceiptsToRefuel(database, previous?.refuelEventId ?? null)
  return updated || null
}

export async function deleteReceipt(database: Database, receipt: RefuelReceipt) {
  await database.delete(refuelReceipts).where(eq(refuelReceipts.id, receipt.id))
  if (receipt.storedName) await removeReceiptFile(receipt.storedName)
  await applyReceiptsToRefuel(database, receipt.refuelEventId)
}

// A receipt regularly reaches the mailbox before the fuel sensor reports the
// jump, so every new refuel event has to look back at what is still waiting.
export async function rematchPendingReceipts(database: Database, vehicleId: number, limit = 50) {
  const pending = await database.select().from(refuelReceipts)
    .where(or(eq(refuelReceipts.matchStatus, 'unmatched'), eq(refuelReceipts.matchStatus, 'suggested')))
    .orderBy(desc(refuelReceipts.purchasedAt))
    .limit(limit)

  const linked: RefuelReceipt[] = []
  for (const receipt of pending) {
    const result = await runReceiptMatch(database, receipt, vehicleId)
    if (result.status === 'auto') linked.push(receipt)
  }
  return linked
}

// The Telegram dialog asks for one missing figure at a time; storing the answer
// may complete the receipt well enough for the matcher to decide.
export async function applyPendingAnswer(database: Database, receipt: RefuelReceipt, value: number, vehicleId?: number) {
  if (!receipt.pendingField) return receipt
  const values = completeReceiptAmounts({
    litres: receipt.litres,
    pricePerLitre: receipt.pricePerLitre,
    totalAmount: receipt.totalAmount,
    [receipt.pendingField]: value
  })

  const [updated] = await database.update(refuelReceipts)
    .set({ ...values, pendingField: null, updatedAt: new Date() })
    .where(eq(refuelReceipts.id, receipt.id)).returning()
  if (!updated) return receipt

  if (vehicleId != null) await runReceiptMatch(database, updated, vehicleId)
  // Corrected figures on an already linked receipt have to reach the refuel too.
  await applyReceiptsToRefuel(database, updated.refuelEventId)
  const [fresh] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, receipt.id)).limit(1)
  return fresh || updated
}

export async function findReceiptByMessageId(database: Database, externalMessageId: string) {
  const [receipt] = await database.select().from(refuelReceipts)
    .where(eq(refuelReceipts.externalMessageId, externalMessageId)).limit(1)
  return receipt || null
}

export async function findReceiptByContentHash(database: Database, contentHash: string) {
  const [receipt] = await database.select().from(refuelReceipts)
    .where(eq(refuelReceipts.contentHash, contentHash)).limit(1)
  return receipt || null
}

export async function findPendingDialogReceipt(database: Database, chatId: string) {
  const [receipt] = await database.select().from(refuelReceipts)
    .where(and(eq(refuelReceipts.pendingChatId, chatId), isNotNull(refuelReceipts.pendingField)))
    .orderBy(desc(refuelReceipts.createdAt)).limit(1)
  return receipt || null
}
