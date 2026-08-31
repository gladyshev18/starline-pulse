import { Bot } from 'grammy'
import { readFile } from 'node:fs/promises'
import { createDatabase } from '../db/client'
import { createTelegramProxyFetch, closeTelegramProxy } from '../worker/bot/proxy'
import { allowedRecipients, recipientName } from '../worker/bot/recipients'
import { config } from '../worker/config'

// Разовая отправка готового текста получателям бота — для еженедельной
// подборки, которую собирает не воркер. Скрипт только шлёт: никакого polling,
// поэтому он безопасно работает рядом с запущенным ботом.
//
//   npx tsx scripts/send-telegram.ts message.json
//   npx tsx scripts/send-telegram.ts message.json --dry-run
//
// В файле либо один текст на всех, либо по тексту на получателя:
//
//   { "text": "<b>Привет!</b>" }
//   { "messages": [{ "username": "@someone", "text": "<b>Привет, Имя!</b>" }] }
//
// Плейсхолдер {name} в общем тексте подставляется именем получателя.

type Message = { username: string, text: string }
type Payload = { text?: string, messages?: Message[], silent?: boolean }

const [, , file, ...rest] = process.argv
const dryRun = rest.includes('--dry-run')
if (!file) {
  console.error('Укажите файл с текстом: npx tsx scripts/send-telegram.ts message.json')
  process.exit(1)
}

const payload = JSON.parse(await readFile(file, 'utf8')) as Payload
if (!payload.text && !payload.messages?.length) {
  console.error('В файле нет ни text, ни messages')
  process.exit(1)
}

const database = createDatabase()
const recipients = await allowedRecipients(database)
if (!recipients.length) {
  console.error('Некому отправлять: в telegram_recipients нет никого из TELEGRAM_ALLOWED_USERNAMES')
  process.exit(1)
}

const byUsername = new Map((payload.messages || []).map(message => [message.username.toLowerCase(), message.text]))
const planned = recipients
  .map(recipient => ({
    recipient,
    text: byUsername.get(recipient.username.toLowerCase())
      ?? payload.text?.replaceAll('{name}', recipientName(recipient))
  }))
  .filter((item): item is { recipient: typeof recipients[number], text: string } => Boolean(item.text))

for (const item of planned) console.log(`→ ${item.recipient.username} (${item.text.length} символов)`)
if (!planned.length) {
  console.error('Ни одному из получателей текст не адресован')
  process.exit(1)
}
if (dryRun) {
  console.log('Пробный прогон: ничего не отправлено')
  process.exit(0)
}
if (!config.telegramBotToken) {
  console.error('TELEGRAM_BOT_TOKEN не задан')
  process.exit(1)
}

const bot = new Bot(config.telegramBotToken, config.telegramProxyUrl
  ? { client: { fetch: createTelegramProxyFetch(config.telegramProxyUrl) } }
  : undefined)

let failed = 0
for (const { recipient, text } of planned) {
  try {
    await bot.api.sendMessage(recipient.chatId, text, {
      parse_mode: 'HTML',
      // Подборка приходит сама, без просьбы, поэтому будит телефон: раз в
      // неделю это уместно, чаще этот скрипт и не зовут.
      disable_notification: payload.silent === true
    })
    console.log(`✓ ${recipient.username}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${recipient.username}`, error instanceof Error ? error.message : error)
  }
}

await closeTelegramProxy()
process.exit(failed ? 1 : 0)
