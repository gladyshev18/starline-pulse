import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client'
import { jobs, serviceDocuments, vehicleSnapshots } from '../db/schema'
import { recognizeAct } from './act-ocr'
import { getServiceDocumentStorageDir, saveParsedAct } from './service-documents'
import { resolveReceiptPath } from './storage'
import { and, desc, isNotNull, lte } from 'drizzle-orm'

// Recognition runs four orientations through Tesseract and takes the better part
// of a minute, which is far too long to keep a Telegram update waiting. The bot
// hands the work to the queue and answers immediately.
export async function scheduleActParse(database: Database, documentId: number) {
  await database.insert(jobs).values({
    type: 'service:parse_act',
    payload: JSON.stringify({ documentId })
  })
}

// The one field OCR never manages is the odometer — it sits alone in a table cell
// with no words around it, and the VIN's last six digits pass for it perfectly.
// It does not have to be read at all: the car reports its odometer all day, so
// the reading on the day of service is already on file.
async function mileageOnDate(database: Database, when: Date) {
  const row = await database.query.vehicleSnapshots.findFirst({
    columns: { mileage: true, ts: true },
    where: and(
      isNotNull(vehicleSnapshots.mileage),
      lte(vehicleSnapshots.ts, new Date(when.getTime() + 24 * 60 * 60_000))
    ),
    orderBy: desc(vehicleSnapshots.ts)
  })
  if (!row?.mileage) return null
  // Only if the history actually reaches that far back; otherwise the newest
  // reading would be offered as the mileage of an act from last year.
  const withinAWeek = Math.abs(row.ts.getTime() - when.getTime()) <= 7 * 24 * 60 * 60_000
  return withinAWeek ? row.mileage : null
}

export async function parseActDocument(database: Database, documentId: number) {
  const document = await database.query.serviceDocuments.findFirst({ where: eq(serviceDocuments.id, documentId) })
  if (!document?.storedName) throw new Error('SERVICE_DOCUMENT_NOT_FOUND')

  const path = resolveReceiptPath(document.storedName, getServiceDocumentStorageDir())
  const data = await readFile(path)
  const result = await recognizeAct(data, join(tmpdir(), `act-ocr-${documentId}`))

  const performedAt = result.performedAt.value ?? null
  const mileage = result.mileage.value ?? (performedAt ? await mileageOnDate(database, performedAt) : null)

  await saveParsedAct(database, documentId, {
    fields: {
      orderNumber: result.orderNumber.value,
      performedAt,
      mileage,
      totalAmount: result.totalAmount.value,
      vendor: null
    },
    details: {
      attempts: result.attempts,
      confidence: Math.round(result.confidence),
      rotation: result.bestRotation,
      isServiceAct: result.isServiceAct,
      mentionsOil: result.mentionsOil,
      // Where the odometer came from matters to whoever checks the draft: read
      // off the paper is one thing, taken from the car's own log is another.
      mileageSource: result.mileage.value != null ? 'ocr' : mileage != null ? 'snapshots' : null,
      votes: {
        orderNumber: result.orderNumber.votes,
        performedAt: result.performedAt.votes,
        mileage: result.mileage.votes,
        totalAmount: result.totalAmount.votes
      },
      disputed: {
        orderNumber: result.orderNumber.disputed,
        performedAt: result.performedAt.disputed,
        mileage: result.mileage.disputed,
        totalAmount: result.totalAmount.disputed
      }
    }
  })
  return result
}
