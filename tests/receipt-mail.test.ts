import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { toBuffer } from 'qrcode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../db/client'
import { imapState, refuelEvents, refuelReceipts, vehicles } from '../db/schema'
import { ingestReceiptMail } from '../receipts/mail/ingest'
import { matchesSenderAllowlist, normalizeMailAddress, type ReceiptMailConfig, type ReceiptMailMessage, type ReceiptMailSource } from '../receipts/mail/types'
import { createFixtureMailSource } from '../receipts/mail/fixture'
import { buildReceiptImportNotice } from '../worker/bot/receipt-notices'

const config: ReceiptMailConfig = {
  mode: 'fixture',
  fixturePath: resolve('fixtures/receipt-mail.example.json'),
  host: '',
  port: 993,
  secure: true,
  user: '',
  password: '',
  mailbox: 'INBOX',
  senderAllowlist: ['platformaofd.ru', 'noreply@ofd.ru'],
  sinceDays: 14,
  maxMessages: 25,
  pollMinutes: 15,
  proxyUrl: '',
  markSeen: false
}

let database: Database
let storageDir: string
let previousStorageDir: string | undefined

function source(messages: ReceiptMailMessage[], lastUid = 0): ReceiptMailSource {
  return { fetch: async () => ({ uidValidity: '1', lastUid, messages }) }
}

function message(values: Partial<ReceiptMailMessage>): ReceiptMailMessage {
  return {
    uid: 1,
    messageId: '<a@platformaofd.ru>',
    addresses: ['noreply@platformaofd.ru'],
    subject: 'Электронный чек',
    date: new Date('2026-08-14T07:35:00.000Z'),
    text: '14.08.2026 10:30\nАИ-95 38,42 л\nИТОГО: 2 516,51',
    html: null,
    attachments: [],
    ...values
  }
}

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'starline-receipts-'))
  previousStorageDir = process.env.RECEIPT_STORAGE_DIR
  process.env.RECEIPT_STORAGE_DIR = storageDir

  database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' })
})

afterEach(() => {
  if (previousStorageDir == null) delete process.env.RECEIPT_STORAGE_DIR
  else process.env.RECEIPT_STORAGE_DIR = previousStorageDir
})

describe('normalizeMailAddress', () => {
  it('unwraps a display name', () => {
    expect(normalizeMailAddress('"Платформа ОФД" <NoReply@PlatformaOfd.ru>')).toBe('noreply@platformaofd.ru')
  })

  it('rejects something that is not an address', () => {
    expect(normalizeMailAddress('Платформа ОФД')).toBeNull()
  })
})

describe('matchesSenderAllowlist', () => {
  it('accepts a whole domain and its subdomains', () => {
    expect(matchesSenderAllowlist(['noreply@mail.platformaofd.ru'], ['platformaofd.ru'])).toBe(true)
  })

  it('accepts an exact address', () => {
    expect(matchesSenderAllowlist(['robot@ofd.ru'], ['robot@ofd.ru'])).toBe(true)
  })

  it('looks past a rewritten envelope sender to the original From', () => {
    expect(matchesSenderAllowlist(['me@gmail.com', 'noreply@platformaofd.ru'], ['platformaofd.ru'])).toBe(true)
  })

  it('rejects a stranger', () => {
    expect(matchesSenderAllowlist(['news@example.com'], ['platformaofd.ru'])).toBe(false)
  })

  it('rejects everything when nothing is allowed', () => {
    expect(matchesSenderAllowlist(['noreply@platformaofd.ru'], [])).toBe(false)
  })
})

describe('ingestReceiptMail', () => {
  it('imports the shipped fixture and skips the newsletter', async () => {
    const summary = await ingestReceiptMail(database, config, createFixtureMailSource(config))

    expect(summary).toMatchObject({ fetched: 2, imported: 1, skipped: 1, failed: 0 })
    const [receipt] = await database.select().from(refuelReceipts)
    expect(receipt).toMatchObject({ source: 'imap', dataSource: 'parsed', litres: 38.42, totalAmount: 2516.51, paymentMethod: 'card' })
    expect(receipt?.purchasedAt?.toISOString()).toBe('2026-08-14T07:30:00.000Z')
  })

  it('links an imported receipt to the refuel it matches', async () => {
    await database.insert(refuelEvents).values({ vehicleId: 1, detectedAt: new Date('2026-08-14T09:00:00.000Z'), litresAdded: 38 })

    const summary = await ingestReceiptMail(database, config, createFixtureMailSource(config))

    expect(summary.linked).toHaveLength(1)
    expect(summary.pending).toHaveLength(0)
  })

  it('never imports the same letter twice', async () => {
    await ingestReceiptMail(database, config, source([message({})]))
    const second = await ingestReceiptMail(database, config, source([message({})]))

    expect(second).toMatchObject({ imported: 0, skipped: 1 })
    expect(await database.select().from(refuelReceipts)).toHaveLength(1)
  })

  it('stores an attachment and keeps its content out of a second receipt', async () => {
    const attachment = { filename: 'чек.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 чек') }
    await ingestReceiptMail(database, config, source([message({ attachments: [attachment] })]))
    await ingestReceiptMail(database, config, source([message({ uid: 2, messageId: '<b@platformaofd.ru>', attachments: [attachment] })]))

    const receipts = await database.select().from(refuelReceipts)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ mimeType: 'application/pdf', originalName: 'чек.pdf' })
    expect(await readdir(storageDir)).toHaveLength(1)
  })

  it('keeps the letter itself when nothing is attached', async () => {
    await ingestReceiptMail(database, config, source([message({ html: '<p>ИТОГО: 2 516,51</p>' })]))

    const [receipt] = await database.select().from(refuelReceipts)
    expect(receipt).toMatchObject({ mimeType: 'text/html', originalName: 'letter.html' })
  })

  it('keeps the letter rather than the QR picture that OFD letters embed', async () => {
    await ingestReceiptMail(database, config, source([message({
      html: '<p>ИТОГО: 2 516,51</p>',
      attachments: [{ filename: 'qr.png', contentType: 'image/png', content: await toBuffer('t=20260814T1030&s=2516.51&fp=99') }]
    })]))

    const [receipt] = await database.select().from(refuelReceipts)
    expect(receipt).toMatchObject({ originalName: 'letter.html', mimeType: 'text/html' })
  })

  it('reads the attached QR code when the letter prints no fiscal link', async () => {
    await ingestReceiptMail(database, config, source([message({
      text: 'Кассовый чек. Приход\nАЗС №241\nБензин автомобильный',
      html: null,
      attachments: [{ filename: 'qr.png', contentType: 'image/png', content: await toBuffer('t=20260814T1030&s=2516.51&fn=996&i=42&fp=99&n=1') }]
    })]))

    const [receipt] = await database.select().from(refuelReceipts)
    expect(receipt).toMatchObject({ totalAmount: 2516.51, fiscalDocNumber: '42', fiscalSign: '99' })
    expect(receipt?.purchasedAt?.toISOString()).toBe('2026-08-14T07:30:00.000Z')
  }, 20_000)

  it('drops a phone bill the operator sent from the very same address', async () => {
    const summary = await ingestReceiptMail(database, config, source([message({
      subject: 'ПАО "РОСТЕЛЕКОМ" 20.08.2026 09:44',
      text: 'Кассовый чек. Приход\n№ Наименование Цена за ед. Кол. Сумма\n1. Аванс за услуги связи 275.15 1 275.15\nИТОГО: 275.15'
    })]))

    expect(summary).toMatchObject({ fetched: 1, imported: 0, notFuel: 1, skipped: 0 })
    expect(await database.select().from(refuelReceipts)).toHaveLength(0)
    expect(await readdir(storageDir)).toHaveLength(0)
  })

  it('remembers where the mailbox was left off', async () => {
    await ingestReceiptMail(database, config, source([message({})], 101))

    const [state] = await database.select().from(imapState)
    expect(state).toMatchObject({ mailbox: 'INBOX', lastUid: 101, uidValidity: '1', lastError: null })
  })

  it('does nothing at all while the import is switched off', async () => {
    const summary = await ingestReceiptMail(database, { ...config, mode: 'off' })

    expect(summary).toMatchObject({ fetched: 0, imported: 0 })
    expect(await database.select().from(imapState)).toHaveLength(0)
  })
})

describe('buildReceiptImportNotice', () => {
  const empty = { fetched: 0, imported: 0, skipped: 0, notFuel: 0, failed: 0, linked: [], pending: [] }

  it('says nothing when the mailbox brought nothing', () => {
    expect(buildReceiptImportNotice(empty)).toBeNull()
  })

  it('reports what was linked and what waits', async () => {
    await ingestReceiptMail(database, config, createFixtureMailSource(config))
    const [receipt] = await database.select().from(refuelReceipts)

    const notice = buildReceiptImportNotice({ ...empty, imported: 1, pending: [receipt!] })

    expect(notice).toContain('Ждут решения: 1')
    expect(notice).toContain('38,42 л')
    expect(notice).toContain('516,51')
  })
})
