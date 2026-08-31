import { setTimeout as delay } from 'node:timers/promises'
import { createDatabase } from '../db/client'
import { createTelegramBot } from './bot'
import { closeTelegramProxy } from './bot/proxy'
import { config } from './config'
import { initializeQueue, processNextJob } from './queue'

const database = createDatabase(config.databaseUrl)
await initializeQueue(database)

if (process.argv.includes('--once')) {
  await processNextJob(database)
  process.exit(0)
}

const bot = createTelegramBot(database)
if (bot) void bot.start({ onStart: async info => {
  await bot.api.setMyCommands([
    { command: 'status', description: 'Текущее состояние автомобиля' },
    { command: 'fuel', description: 'Сколько заправить до полного бака' },
    { command: 'last', description: 'Последние пять поездок' },
    { command: 'receipts', description: 'Заправки без чеков' },
    { command: 'day', description: 'Отчёт за вчера' },
    { command: 'week', description: 'Отчёт за прошлую неделю' },
    { command: 'month', description: 'Отчёт за прошлый месяц' },
    { command: 'menu', description: 'Показать кнопки меню' },
    { command: 'hide', description: 'Убрать кнопки меню' }
  ])
  console.log(`Telegram bot @${info.username} started`)
} })
console.log(`Worker started in ${config.starlineMode} mode`)

let running = true
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  running = false
  bot?.stop()
  void closeTelegramProxy()
})
while (running) {
  while (await processNextJob(database)) { /* drain ready jobs */ }
  await delay(10_000)
}
