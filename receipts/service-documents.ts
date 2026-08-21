import { resolve } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import type { Database } from '../db/client'
import { serviceDocuments, type ServiceDocument } from '../db/schema'
import { removeReceiptFile } from './storage'
import type { ReceiptFile } from './store'

// Kept apart from the fuel receipts on disk as well as in the database. They are
// different documents with different lifetimes, and mixing them in one folder
// would make the pile impossible to sort by hand later.
export function getServiceDocumentStorageDir() {
  return process.env.SERVICE_DOCUMENT_STORAGE_DIR || resolve(process.cwd(), 'data/service-documents')
}

export async function findServiceDocumentByContentHash(database: Database, contentHash: string) {
  return database.query.serviceDocuments.findFirst({ where: eq(serviceDocuments.contentHash, contentHash) })
}

export async function createServiceDocument(database: Database, input: {
  file: ReceiptFile
  source?: 'telegram' | 'manual'
  kind?: 'unknown' | 'act'
  receivedAt?: Date
  pendingChatId?: string | null
}) {
  const [created] = await database.insert(serviceDocuments).values({
    kind: input.kind ?? 'unknown',
    source: input.source ?? 'telegram',
    receivedAt: input.receivedAt ?? new Date(),
    originalName: input.file.originalName,
    storedName: input.file.storedName,
    mimeType: input.file.mimeType,
    size: input.file.size,
    contentHash: input.file.contentHash,
    pendingChatId: input.pendingChatId ?? null
  }).returning()
  return created!
}

export async function markServiceDocumentKind(database: Database, id: number, kind: 'unknown' | 'act') {
  const [updated] = await database.update(serviceDocuments)
    .set({ kind, pendingChatId: null, updatedAt: new Date() })
    .where(eq(serviceDocuments.id, id))
    .returning()
  return updated ?? null
}

// Used when a document turns out to be a fuel receipt after all: the file itself
// stays where it is and is handed to the receipt store, so only the row goes.
export async function detachServiceDocument(database: Database, id: number) {
  const [removed] = await database.delete(serviceDocuments).where(eq(serviceDocuments.id, id)).returning()
  return removed ?? null
}

export async function deleteServiceDocument(database: Database, id: number) {
  const removed = await detachServiceDocument(database, id)
  if (removed?.storedName) await removeReceiptFile(removed.storedName, getServiceDocumentStorageDir())
  return removed
}

export interface ParsedActFields {
  orderNumber: string | null
  performedAt: Date | null
  mileage: number | null
  totalAmount: number | null
  vendor: string | null
  note: string | null
}

// The reading is written down as a draft, never as fact: OCR gets the header of
// this form right and the table wrong, so the row below is what the confirmation
// dialog opens with, not what the car's history is built from.
export async function saveParsedAct(database: Database, id: number, input: {
  fields: Partial<ParsedActFields>
  details: unknown
}) {
  const [updated] = await database.update(serviceDocuments).set({
    orderNumber: input.fields.orderNumber ?? null,
    performedAt: input.fields.performedAt ?? null,
    mileage: input.fields.mileage ?? null,
    totalAmount: input.fields.totalAmount ?? null,
    vendor: input.fields.vendor ?? null,
    parsedAt: new Date(),
    parsedJson: JSON.stringify(input.details),
    updatedAt: new Date()
  }).where(eq(serviceDocuments.id, id)).returning()
  return updated ?? null
}

// What the person confirmed, which outranks anything that was recognised.
export async function applyConfirmedAct(database: Database, id: number, fields: ParsedActFields & { serviceEventId: number | null }) {
  const [updated] = await database.update(serviceDocuments).set({
    kind: 'act',
    orderNumber: fields.orderNumber,
    performedAt: fields.performedAt,
    mileage: fields.mileage,
    totalAmount: fields.totalAmount,
    vendor: fields.vendor,
    note: fields.note,
    serviceEventId: fields.serviceEventId,
    updatedAt: new Date()
  }).where(eq(serviceDocuments.id, id)).returning()
  return updated ?? null
}

export async function listServiceDocuments(database: Database, limit = 100): Promise<ServiceDocument[]> {
  return database.select().from(serviceDocuments).orderBy(desc(serviceDocuments.receivedAt)).limit(limit)
}
