import { and, desc, eq } from 'drizzle-orm'
import type { Bot, Context } from 'grammy'
import type { Database } from '../../db/client'
import { telegramRecipients, trips, vehicleSnapshots } from '../../db/schema'
import { config, normalizeTelegramUsername } from '../config'
import { buttonLabels, mainKeyboard } from './keyboard'
import { buildReport, type ReportPeriod } from './reports'

const decimal = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' })
const replyOptions = { disable_notification: true, parse_mode: 'HTML' as const }

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function number(value: number | null | undefined, suffix: string) {
  return value == null ? '—' : `${decimal.format(value)} ${suffix}`
}

function engineState(online: boolean | null, ignition: boolean | null) {
  if (online === false) return 'не в сети'
  if (ignition === true) return 'двигатель работает'
  if (ignition === false) return 'двигатель выключен'
  return 'состояние неизвестно'
}

async function reply(context: Context, text: string, keyboard = true) {
  return context.reply(text, keyboard ? { ...replyOptions, reply_markup: mainKeyboard } : replyOptions)
}

async function report(context: Context, database: Database, period: ReportPeriod) {
  return reply(context, await buildReport(database, period))
}

export function registerCommands(bot: Bot, database: Database) {
  bot.command('start', async (context: Context) => {
    const username = normalizeTelegramUsername(context.from?.username)
    if (!username) return reply(context, 'Чтобы подключить уведомления, задайте публичный username в Telegram и снова отправьте /start.', false)
    if (!config.telegramAllowedUsernames.has(username)) return reply(context, `Для ${escapeHtml(username)} доступ к уведомлениям не настроен.`, false)

    const chatId = context.chat?.id.toString()
    if (!chatId) return
    await database.delete(telegramRecipients).where(eq(telegramRecipients.chatId, chatId))
    await database.insert(telegramRecipients).values({
      username, chatId, firstName: context.from?.first_name || null
    }).onConflictDoUpdate({
      target: telegramRecipients.username,
      set: { chatId, firstName: context.from?.first_name || null, updatedAt: new Date() }
    })
    return reply(context, [
      '✅ <b>Уведомления подключены</b>',
      '',
      `Получатель: ${escapeHtml(username)}`,
      'Chat ID определён и сохранён автоматически.',
      '',
      'Все автоматические сообщения приходят без звука.',
      'Выберите нужное действие на клавиатуре ниже.'
    ].join('\n'))
  })

  const showStatus = async (context: Context) => {
    const vehicle = await database.query.vehicles.findFirst()
    if (!vehicle) return reply(context, 'Данных об автомобиле пока нет.')
    const snapshot = await database.query.vehicleSnapshots.findFirst({ where: eq(vehicleSnapshots.vehicleId, vehicle.id), orderBy: desc(vehicleSnapshots.ts) })
    if (!snapshot) return reply(context, 'Снимков состояния пока нет.')
    return reply(context, [
      `🚗 <b>${escapeHtml(vehicle.alias)}</b>`,
      `Состояние: ${engineState(snapshot.online, snapshot.ignition)}`,
      `Пробег: ${number(snapshot.mileage, 'км')}`,
      `Топливо: ${number(snapshot.fuel, 'л')}`,
      `АКБ: ${number(snapshot.battery, snapshot.batteryType === 'percent' ? '%' : 'В')}`,
      `Последняя связь: ${date.format(snapshot.activityTs || snapshot.ts)}`
    ].join('\n'))
  }

  const showLastTrips = async (context: Context) => {
    const vehicle = await database.query.vehicles.findFirst()
    if (!vehicle) return reply(context, 'Поездок пока нет.')
    const items = await database.select().from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false))).orderBy(desc(trips.startedAt)).limit(5)
    if (!items.length) return reply(context, 'Поездок пока нет.')
    return reply(context, [
      '🛣 <b>Последние поездки</b>',
      '',
      ...items.map(item => `• ${date.format(item.startedAt)} — ${number(item.distance, 'км')}, ${number(item.fuelUsed, 'л')}`)
    ].join('\n'))
  }

  bot.command('status', showStatus)
  bot.command('last', showLastTrips)

  bot.command('day', context => report(context, database, 'daily'))
  bot.command('week', context => report(context, database, 'weekly'))
  bot.command('month', context => report(context, database, 'monthly'))

  bot.hears(buttonLabels.status, showStatus)
  bot.hears(buttonLabels.last, showLastTrips)
  bot.hears(buttonLabels.day, context => report(context, database, 'daily'))
  bot.hears(buttonLabels.week, context => report(context, database, 'weekly'))
  bot.hears(buttonLabels.month, context => report(context, database, 'monthly'))
}
