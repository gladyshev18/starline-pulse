import { and, eq } from 'drizzle-orm'
import { Bot, type InlineKeyboard } from 'grammy'
import type { Database } from '../../db/client'
import { telegramRecipients } from '../../db/schema'
import { config, normalizeTelegramUsername } from '../config'
import { registerCommands } from './commands'
import { registerReceiptHandlers } from './receipts'
import { allowedRecipients } from './recipients'
import { registerTripDriverHandlers } from './trip-driver'
import { createTelegramProxyFetch } from './proxy'

let bot: Bot | null = null
let botDatabase: Database | null = null

function isStartCommand(text: string | undefined) {
  return /^\/start(?:@\w+)?(?:\s|$)/i.test(text || '')
}

export function createTelegramBot(database: Database) {
  if (!config.telegramBotToken) return null
  botDatabase = database
  bot = new Bot(config.telegramBotToken, config.telegramProxyUrl ? {
    client: { fetch: createTelegramProxyFetch(config.telegramProxyUrl) }
  } : undefined)
  bot.use(async (context, next) => {
    if (context.chat?.type !== 'private') return
    if (isStartCommand(context.message?.text)) return next()

    const username = normalizeTelegramUsername(context.from?.username)
    const chatId = context.chat?.id.toString()
    if (!username || !chatId || !config.telegramAllowedUsernames.has(username)) return
    const recipient = await database.query.telegramRecipients.findFirst({
      where: and(eq(telegramRecipients.username, username), eq(telegramRecipients.chatId, chatId))
    })
    if (recipient) await next()
  })
  registerCommands(bot, database)
  registerReceiptHandlers(bot, database)
  registerTripDriverHandlers(bot, database)
  bot.catch(error => console.error('Telegram bot error', error.error))
  return bot
}

type NotificationOptions = {
  html?: boolean
  sound?: boolean
  // Сообщение с вопросом несёт свои кнопки. Главное меню сюда не прикладываем
  // вовсе: чат помнит его сам, а спрятанное командой /hide иначе вернулось бы
  // первым же уведомлением.
  keyboard?: InlineKeyboard
}

export async function notifyAllowedChats(text: string, options: NotificationOptions = {}) {
  if (!bot) {
    if (config.telegramBotToken) throw new Error('Telegram bot is not running')
    console.log(`[telegram disabled] ${text}`)
    return
  }
  const recipients = await botRecipients()
  const results = await Promise.allSettled(recipients.map(recipient => bot!.api.sendMessage(recipient.chatId, text, {
    disable_notification: options.sound !== true,
    ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
    ...(options.html ? { parse_mode: 'HTML' as const } : {})
  })))
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.error(`Telegram notification to ${recipients[index]?.username} failed`, result.reason)
  })
}

async function botRecipients() {
  if (!bot || !botDatabase) return []
  return allowedRecipients(botDatabase)
}
