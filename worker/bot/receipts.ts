import { and, desc, eq, inArray } from 'drizzle-orm'
import { InlineKeyboard, type Bot, type Context } from 'grammy'
import type { Database } from '../../db/client'
import { refuelEvents, refuelReceipts, serviceDocuments, type RefuelReceipt } from '../../db/schema'
import { missingReceiptField, normalizeReceiptFields, parseNumericAnswer } from '../../receipts/fields'
import { readReceiptQr } from '../../receipts/qr'
import {
  applyPendingAnswer,
  createReceipt,
  findPendingDialogReceipt,
  findReceiptByContentHash,
  isReceiptConfirming,
  linkReceiptToRefuel,
  rejectReceiptMatch,
  type ReceiptFile
} from '../../receipts/store'
import {
  createServiceDocument,
  detachServiceDocument,
  findServiceDocumentByContentHash,
  getServiceDocumentStorageDir,
  markServiceDocumentKind
} from '../../receipts/service-documents'
import {
  MAX_RECEIPT_SIZE,
  getReceiptStorageDir,
  moveReceiptFile,
  receiptContentHash,
  receiptFileNameFor,
  saveReceiptFile
} from '../../receipts/storage'
import { config } from '../config'
import { mainKeyboard } from './keyboard'
import { telegramFetch } from './proxy'

const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })
const moment = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' })
const replyOptions = { disable_notification: true, parse_mode: 'HTML' as const }

const prompts = {
  litres: 'Сколько литров залито? Ответьте числом, например <code>38,4</code>.',
  totalAmount: 'На какую сумму заправились? Ответьте числом в рублях.',
  pricePerLitre: 'Какая цена за литр? Ответьте числом в рублях.'
} as const

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

async function reply(context: Context, text: string, keyboard?: InlineKeyboard) {
  return context.reply(text, { ...replyOptions, reply_markup: keyboard || mainKeyboard })
}

function receiptSummary(receipt: RefuelReceipt) {
  const parts = [
    receipt.purchasedAt ? moment.format(receipt.purchasedAt) : 'без даты',
    receipt.litres != null ? `${decimal.format(receipt.litres)} л` : null,
    receipt.totalAmount != null ? money.format(receipt.totalAmount) : null
  ].filter(Boolean)
  return parts.join(' · ')
}

async function downloadTelegramFile(context: Context, fileId: string) {
  const file = await context.api.getFile(fileId)
  if (!file.file_path) throw new Error('TELEGRAM_FILE_WITHOUT_PATH')
  if (file.file_size != null && file.file_size > MAX_RECEIPT_SIZE) throw new Error('RECEIPT_TOO_LARGE')

  const response = await telegramFetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`)
  if (!response.ok) throw new Error(`TELEGRAM_FILE_DOWNLOAD_${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > MAX_RECEIPT_SIZE) throw new Error('RECEIPT_TOO_LARGE')
  return { data, path: file.file_path }
}

function matchKeyboard(receipt: RefuelReceipt) {
  const keyboard = new InlineKeyboard()
  if (receipt.suggestedRefuelEventId) keyboard.text('Да, эта заправка', `receipt:link:${receipt.id}:${receipt.suggestedRefuelEventId}`)
  keyboard.text('Это не заправка', `receipt:reject:${receipt.id}`)
  return keyboard
}

async function describeOutcome(database: Database, receipt: RefuelReceipt) {
  if (isReceiptConfirming(receipt) && receipt.refuelEventId) {
    const [refuel] = await database.select().from(refuelEvents).where(eq(refuelEvents.id, receipt.refuelEventId)).limit(1)
    const when = refuel ? moment.format(refuel.detectedAt) : ''
    return { text: `✅ Чек привязан к заправке ${escapeHtml(when)}.`, keyboard: undefined }
  }
  if (receipt.matchStatus === 'suggested' && receipt.suggestedRefuelEventId) {
    const [refuel] = await database.select().from(refuelEvents).where(eq(refuelEvents.id, receipt.suggestedRefuelEventId)).limit(1)
    const when = refuel ? moment.format(refuel.detectedAt) : ''
    const litres = refuel?.litresAdded != null ? `, ${decimal.format(refuel.litresAdded)} л` : ''
    return { text: `Похоже на заправку ${escapeHtml(when)}${litres}. Привязать?`, keyboard: matchKeyboard(receipt) }
  }
  return { text: 'Подходящей заправки пока нет — чек подождёт её в разделе «Чеки».', keyboard: undefined }
}

async function finishReceipt(context: Context, database: Database, receipt: RefuelReceipt) {
  const missing = missingReceiptField(receipt)
  if (missing) {
    await database.update(refuelReceipts)
      .set({ pendingField: missing, pendingChatId: context.chat?.id.toString() || null, updatedAt: new Date() })
      .where(eq(refuelReceipts.id, receipt.id))
    return reply(context, `${receiptSummary(receipt)}\n\n${prompts[missing]}`)
  }

  await database.update(refuelReceipts).set({ pendingField: null, pendingChatId: null, updatedAt: new Date() })
    .where(eq(refuelReceipts.id, receipt.id))
  const [fresh] = await database.select().from(refuelReceipts).where(eq(refuelReceipts.id, receipt.id)).limit(1)
  const outcome = await describeOutcome(database, fresh || receipt)
  return reply(context, `🧾 <b>${escapeHtml(receiptSummary(fresh || receipt))}</b>\n\n${outcome.text}`, outcome.keyboard)
}

function kindKeyboard(documentId: number) {
  return new InlineKeyboard()
    .text('⛽ Чек на топливо', `doc:fuel:${documentId}`)
    .text('🔧 Акт по ТО', `doc:act:${documentId}`)
}

async function createFuelReceipt(context: Context, database: Database, input: {
  file: ReceiptFile
  fiscal: Awaited<ReturnType<typeof readReceiptQr>>
  sentAt: Date
}) {
  const { receipt } = await createReceipt(database, {
    source: 'telegram',
    dataSource: input.fiscal ? 'qr' : 'manual',
    file: input.file,
    pendingChatId: context.chat?.id.toString() || null,
    fields: normalizeReceiptFields({
      // Without a QR code the send time is the closest thing to a purchase time,
      // and the matcher only needs it to be in the right hours.
      purchasedAt: input.fiscal?.purchasedAt || input.sentAt,
      totalAmount: input.fiscal?.totalAmount ?? null,
      fiscalDocNumber: input.fiscal?.fiscalDocNumber ?? null,
      fiscalSign: input.fiscal?.fiscalSign ?? null
    })
  })
  return receipt
}

// A photo can be a fuel receipt or a service act, and nothing in the picture says
// which until an act parser exists. A fiscal QR settles it — only a till prints
// one, and every fuel receipt has it — so that path stays automatic. Everything
// else is stored unclassified and the question is asked, because guessing would
// either bury acts in the fuel receipts or start asking for litres about a
// gearbox oil change.
async function handleIncomingFile(context: Context, database: Database) {
  const message = context.message
  if (!message) return
  const document = message.document
  const photo = message.photo?.at(-1)
  const fileId = photo?.file_id || document?.file_id
  if (!fileId) return

  let downloaded: Awaited<ReturnType<typeof downloadTelegramFile>>
  try {
    downloaded = await downloadTelegramFile(context, fileId)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'RECEIPT_TOO_LARGE') return reply(context, 'Файл больше 15 МБ — пришлите фото поменьше.')
    console.error('Telegram file download failed', error)
    return reply(context, 'Не удалось забрать файл из Telegram. Попробуйте ещё раз.')
  }

  const contentHash = receiptContentHash(downloaded.data)
  const duplicate = await findReceiptByContentHash(database, contentHash)
  if (duplicate) return reply(context, `Этот чек уже сохранён: ${escapeHtml(receiptSummary(duplicate))}.`)
  const duplicateDocument = await findServiceDocumentByContentHash(database, contentHash)
  if (duplicateDocument) {
    return duplicateDocument.kind === 'act'
      ? reply(context, 'Этот документ уже сохранён как акт по ТО.')
      : reply(context, 'Этот файл уже загружен, но ещё не отмечен.', kindKeyboard(duplicateDocument.id))
  }

  let fileName: string
  try {
    fileName = receiptFileNameFor(document?.file_name || downloaded.path, document?.mime_type || 'image/jpeg')
  } catch {
    return reply(context, 'Такой файл не подходит: пришлите фото, PDF или HTML-чек.')
  }

  const isImage = fileName.match(/\.(jpg|jpeg|png|gif|webp|avif|heic|heif)$/i) != null
  const fiscal = isImage ? await readReceiptQr(downloaded.data) : null

  if (fiscal) {
    let saved: ReceiptFile
    try {
      saved = await saveReceiptFile({ data: downloaded.data, originalName: fileName })
    } catch (error) {
      console.error('Telegram receipt storage failed', error)
      return reply(context, 'Не удалось сохранить файл чека.')
    }
    const receipt = await createFuelReceipt(context, database, { file: saved, fiscal, sentAt: new Date(message.date * 1000) })
    await reply(context, `Прочитал QR-код: ${escapeHtml(receiptSummary(receipt))}.`)
    return finishReceipt(context, database, receipt)
  }

  let stored: ReceiptFile
  try {
    stored = await saveReceiptFile({
      data: downloaded.data,
      originalName: fileName,
      storageDir: getServiceDocumentStorageDir()
    })
  } catch (error) {
    console.error('Telegram document storage failed', error)
    return reply(context, 'Не удалось сохранить файл.')
  }

  const created = await createServiceDocument(database, {
    file: stored,
    source: 'telegram',
    receivedAt: new Date(message.date * 1000),
    pendingChatId: context.chat?.id.toString() || null
  })
  return reply(context, 'Файл сохранён. QR-кода на нём нет — что это?', kindKeyboard(created.id))
}

async function classifyDocument(context: Context, database: Database, id: number, kind: 'fuel' | 'act') {
  const existing = await database.query.serviceDocuments.findFirst({ where: eq(serviceDocuments.id, id) })
  if (!existing) {
    await context.answerCallbackQuery('Файл не найден')
    return
  }
  if (kind === 'act') {
    await markServiceDocumentKind(database, id, 'act')
    await context.answerCallbackQuery('Записал как акт')
    return context.editMessageText('🔧 Сохранил как акт по ТО. Разбор содержимого добавим позже.', replyOptions)
  }

  // The file lives in the service pile until now; the receipt store owns the
  // other folder, so the file moves and only the row is dropped.
  if (!existing.storedName || !existing.mimeType || existing.size == null || !existing.contentHash) {
    await context.answerCallbackQuery('Файл повреждён')
    return
  }
  await moveReceiptFile(existing.storedName, getServiceDocumentStorageDir(), getReceiptStorageDir())
  await detachServiceDocument(database, id)
  const receipt = await createFuelReceipt(context, database, {
    file: {
      originalName: existing.originalName || existing.storedName,
      storedName: existing.storedName,
      mimeType: existing.mimeType,
      size: existing.size,
      contentHash: existing.contentHash
    },
    fiscal: null,
    sentAt: existing.receivedAt
  })
  await context.answerCallbackQuery('Записал как чек')
  await context.editMessageText('⛽ Сохранил как чек на топливо.', replyOptions)
  return finishReceipt(context, database, receipt)
}

async function handlePendingAnswer(context: Context, database: Database, next: () => Promise<void>) {
  const chatId = context.chat?.id.toString()
  const text = context.message?.text?.trim()
  if (!chatId || !text) return next()

  const receipt = await findPendingDialogReceipt(database, chatId)
  if (!receipt?.pendingField) return next()

  const value = parseNumericAnswer(text)
  if (value == null) return reply(context, `Не понял число. ${prompts[receipt.pendingField]}`)

  const vehicle = await database.query.vehicles.findFirst()
  const updated = await applyPendingAnswer(database, receipt, value, vehicle?.id)
  return finishReceipt(context, database, updated)
}

async function showUnconfirmedRefuels(context: Context, database: Database) {
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return reply(context, 'Данных об автомобиле пока нет.')

  const events = await database.select().from(refuelEvents)
    .where(eq(refuelEvents.vehicleId, vehicle.id))
    .orderBy(desc(refuelEvents.detectedAt)).limit(20)
  if (!events.length) return reply(context, 'Заправок пока нет.')

  const confirmed = new Set((await database.select({ refuelEventId: refuelReceipts.refuelEventId })
    .from(refuelReceipts)
    .where(and(
      inArray(refuelReceipts.refuelEventId, events.map(item => item.id)),
      inArray(refuelReceipts.matchStatus, ['auto', 'manual'])
    ))).map(row => row.refuelEventId))

  const pending = events.filter(item => !confirmed.has(item.id))
  if (!pending.length) return reply(context, '✅ Все последние заправки подтверждены чеками.')

  return reply(context, [
    `🧾 <b>Без чека: ${pending.length}</b>`,
    '',
    ...pending.slice(0, 10).map(item => `• ${escapeHtml(moment.format(item.detectedAt))} — ${item.litresAdded != null ? `${decimal.format(item.litresAdded)} л` : 'объём неизвестен'}`),
    '',
    'Пришлите фото чека сюда — привяжу к заправке сам.'
  ].join('\n'))
}

export function registerReceiptHandlers(bot: Bot, database: Database) {
  bot.command('receipts', context => showUnconfirmedRefuels(context, database))

  bot.on(['message:photo', 'message:document'], context => handleIncomingFile(context, database))

  bot.callbackQuery(/^doc:(fuel|act):(\d+)$/, async (context) => {
    const [, action, rawId] = context.match as RegExpMatchArray
    return classifyDocument(context, database, Number(rawId), action as 'fuel' | 'act')
  })

  bot.callbackQuery(/^receipt:(link|reject):(\d+)(?::(\d+))?$/, async (context) => {
    const [, action, rawReceiptId, rawRefuelId] = context.match as RegExpMatchArray
    const id = Number(rawReceiptId)
    if (action === 'reject') {
      await rejectReceiptMatch(database, id)
      await context.answerCallbackQuery('Отмечено')
      return context.editMessageText('Чек отмечен как не относящийся к заправке.', replyOptions)
    }
    const refuelEventId = Number(rawRefuelId)
    if (!Number.isSafeInteger(refuelEventId) || refuelEventId < 1) return context.answerCallbackQuery('Заправка не выбрана')
    await linkReceiptToRefuel(database, id, refuelEventId)
    await context.answerCallbackQuery('Привязал')
    return context.editMessageText('✅ Чек привязан к заправке.', replyOptions)
  })

  // Registered last so command and keyboard handlers keep their priority; only
  // an unclaimed message can be the answer to a pending question.
  bot.on('message:text', (context, next) => handlePendingAnswer(context, database, next))
}
