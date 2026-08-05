import { Bot } from 'grammy'
import type { Database } from '../../db/client'
import { config } from '../config'
import { registerCommands } from './commands'

let bot: Bot | null = null

export function createTelegramBot(database: Database) {
  if (!config.telegramBotToken) return null
  bot = new Bot(config.telegramBotToken)
  bot.use(async (context, next) => {
    const chatId = context.chat?.id?.toString()
    if (!chatId || !config.telegramAllowedChatIds.has(chatId)) return
    await next()
  })
  registerCommands(bot, database)
  bot.catch(error => console.error('Telegram bot error', error.error))
  return bot
}

export async function notifyAllowedChats(text: string) {
  if (!bot) {
    if (config.telegramBotToken) throw new Error('Telegram bot is not running')
    console.log(`[telegram disabled] ${text}`)
    return
  }
  await Promise.all([...config.telegramAllowedChatIds].map(chatId => bot!.api.sendMessage(chatId, text)))
}
