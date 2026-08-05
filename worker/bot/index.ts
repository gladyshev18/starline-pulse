import { and, eq } from 'drizzle-orm'
import { Bot } from 'grammy'
import type { Database } from '../../db/client'
import { telegramRecipients } from '../../db/schema'
import { config, normalizeTelegramUsername } from '../config'
import { registerCommands } from './commands'
import { mainKeyboard } from './keyboard'
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
  bot.catch(error => console.error('Telegram bot error', error.error))
  return bot
}

type NotificationOptions = {
  html?: boolean
  sound?: boolean
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
    reply_markup: mainKeyboard,
    ...(options.html ? { parse_mode: 'HTML' as const } : {})
  })))
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.error(`Telegram notification to ${recipients[index]?.username} failed`, result.reason)
  })
}

async function botRecipients() {
  if (!bot || !botDatabase) return []
  // The database stores discovered chat IDs, while the environment remains the
  // source of truth for who is currently allowed to receive notifications.
  const recipients = await botDatabase.select().from(telegramRecipients)
  return recipients.filter(recipient => config.telegramAllowedUsernames.has(recipient.username))
}
