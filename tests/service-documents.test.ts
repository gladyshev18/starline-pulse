import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { vehicles } from '../db/schema'
import {
  createServiceDocument,
  deleteServiceDocument,
  detachServiceDocument,
  findServiceDocumentByContentHash,
  getServiceDocumentStorageDir,
  listServiceDocuments,
  markServiceDocumentKind
} from '../receipts/service-documents'
import { moveReceiptFile, resolveReceiptPath, saveReceiptFile } from '../receipts/storage'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'chery-docs-'))
})
afterEach(async () => {
  delete process.env.SERVICE_DOCUMENT_STORAGE_DIR
  await rm(workspace, { recursive: true, force: true })
})

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' })
  return database
}

const photo = () => Buffer.from('акт выполненных работ', 'utf8')

describe('service document storage', () => {
  it('keeps acts in their own folder, away from the fuel receipts', () => {
    process.env.SERVICE_DOCUMENT_STORAGE_DIR = join(workspace, 'acts')
    expect(getServiceDocumentStorageDir()).toBe(join(workspace, 'acts'))
    delete process.env.SERVICE_DOCUMENT_STORAGE_DIR
    expect(getServiceDocumentStorageDir()).toBe(resolve(process.cwd(), 'data/service-documents'))
  })

  it('stores a photo and finds it again by its content', async () => {
    const database = await setup()
    try {
      const file = await saveReceiptFile({ data: photo(), originalName: 'act.jpg', storageDir: workspace })
      const created = await createServiceDocument(database, { file, pendingChatId: '77' })
      expect(created.kind).toBe('unknown')
      expect(created.pendingChatId).toBe('77')

      const found = await findServiceDocumentByContentHash(database, file.contentHash)
      expect(found?.id).toBe(created.id)
      expect(await listServiceDocuments(database)).toHaveLength(1)
    } finally {
      await database.$client.close()
    }
  })

  it('marks a document as an act and clears the pending question', async () => {
    const database = await setup()
    try {
      const file = await saveReceiptFile({ data: photo(), originalName: 'act.jpg', storageDir: workspace })
      const created = await createServiceDocument(database, { file, pendingChatId: '77' })
      const updated = await markServiceDocumentKind(database, created.id, 'act')
      expect(updated).toMatchObject({ kind: 'act', pendingChatId: null })
    } finally {
      await database.$client.close()
    }
  })

  it('detaching drops the row but leaves the file for the receipt store', async () => {
    const database = await setup()
    try {
      const file = await saveReceiptFile({ data: photo(), originalName: 'act.jpg', storageDir: workspace })
      const created = await createServiceDocument(database, { file })
      await detachServiceDocument(database, created.id)
      expect(await listServiceDocuments(database)).toHaveLength(0)
      // The file is what the receipt row will point at, so it must survive.
      await expect(stat(resolveReceiptPath(file.storedName, workspace))).resolves.toBeDefined()
    } finally {
      await database.$client.close()
    }
  })

  it('deleting takes the file with it', async () => {
    process.env.SERVICE_DOCUMENT_STORAGE_DIR = workspace
    const database = await setup()
    try {
      const file = await saveReceiptFile({ data: photo(), originalName: 'act.jpg', storageDir: workspace })
      const created = await createServiceDocument(database, { file })
      await deleteServiceDocument(database, created.id)
      await expect(stat(resolveReceiptPath(file.storedName, workspace))).rejects.toThrow()
    } finally {
      await database.$client.close()
    }
  })
})

describe('moveReceiptFile', () => {
  it('carries a file to the other pile under the same stored name', async () => {
    const from = join(workspace, 'from')
    const to = join(workspace, 'to')
    const file = await saveReceiptFile({ data: photo(), originalName: 'act.jpg', storageDir: from })

    await moveReceiptFile(file.storedName, from, to)
    // The stored name is what the database row points at, so it must not change.
    expect(await readFile(resolveReceiptPath(file.storedName, to))).toEqual(photo())
    await expect(stat(resolveReceiptPath(file.storedName, from))).rejects.toThrow()
  })

  it('refuses a stored name that tries to climb out of the folder', async () => {
    await expect(moveReceiptFile('../escape.jpg', workspace, workspace)).rejects.toThrow('INVALID_STORED_NAME')
  })
})
