import { and, desc, eq } from 'drizzle-orm'
import type { Bot, Context } from 'grammy'
import type { Database } from '../../db/client'
import { telegramRecipients, trips, vehicleSnapshots } from '../../db/schema'
import { fuelForecast } from '../../metrics/forecast'
import { FUEL_TANK_CAPACITY_LITRES, fuelToFull } from '../../shared/fuel'
import { parseMonthInput } from '../../shared/moscow-month'
import { config, normalizeTelegramUsername } from '../config'
import { buttonLabels, mainKeyboard } from './keyboard'
import { buildReport, type ReportPeriod } from './reports'
import { buildMonthStats } from './stats'

const decimal = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' })
const replyOptions = { disable_notification: true, parse_mode: 'HTML' as const }

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function number(value: number | null | undefined, suffix: string) {
  return value == null ? '—' : `${decimal.format(value)} ${suffix}`
}

// Запас хода — километрами, а потом днями. Дней три, а не одно среднее: в
// тихий день машина проезжает тринадцать километров, в активный сто тридцать, и
// «хватит на пять дней» было бы враньём в обе стороны сразу.
function rangeLines(forecast: Awaited<ReturnType<typeof fuelForecast>>) {
  if (forecast.km == null) return []
  const lines = ['', `Хватит примерно на <b>${Math.round(forecast.km)} км</b>`]
  if (forecast.consumption != null) lines.push(`при расходе ${number(forecast.consumption, 'л/100 км')} за месяц`)
  if (forecast.days) {
    lines.push(`Это ${Math.round(forecast.days.busy)}–${Math.round(forecast.days.quiet)} дней с поездками, обычно около ${Math.round(forecast.days.typical)}`)
  }
  if (forecast.trips) {
    lines.push(`Или ${Math.round(forecast.trips.longCount)} дальних поездок по ${Math.round(forecast.trips.long)} км`)
  }
  return lines
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

const MONTH_HINT = 'Не понял месяц. Напишите <code>/stats июль</code>, <code>/stats 07.2026</code> или <code>/stats 2026-07</code>.'

// The month arrows live on the message itself, so the statistics reply carries an
// inline keyboard instead of the main one. The main keyboard is persistent and
// stays on screen regardless.
async function showStats(context: Context, database: Database, requested?: string) {
  const month = requested ? parseMonthInput(requested) : null
  if (requested && !month) return reply(context, MONTH_HINT)

  const stats = await buildMonthStats(database, month)
  if (!stats) return reply(context, MONTH_HINT)
  return context.reply(stats.text, { ...replyOptions, reply_markup: stats.keyboard })
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
      'Выберите нужное действие на клавиатуре ниже.',
      '',
      'Статистика за другой месяц: <code>/stats июль</code>, <code>/stats 07.2026</code> или стрелками под сообщением.'
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

  const showFuelToFull = async (context: Context) => {
    const vehicle = await database.query.vehicles.findFirst()
    if (!vehicle) return reply(context, 'Данных об автомобиле пока нет.')
    const snapshot = await database.query.vehicleSnapshots.findFirst({ where: eq(vehicleSnapshots.vehicleId, vehicle.id), orderBy: desc(vehicleSnapshots.ts) })
    const toFull = fuelToFull(snapshot?.fuel)
    if (toFull == null) return reply(context, 'Уровень топлива пока неизвестен.')
    const forecast = await fuelForecast(database, vehicle.id)
    return reply(context, [
      '⛽ <b>Заправка до полного бака</b>',
      '',
      `Сейчас в баке: ${number(snapshot?.fuel, 'л')}`,
      `Нужно заправить: <b>${number(toFull, 'л')}</b>`,
      `Объём бака: ${number(FUEL_TANK_CAPACITY_LITRES, 'л')}`,
      ...rangeLines(forecast)
    ].join('\n'))
  }

  bot.command('status', showStatus)
  bot.command('fuel', showFuelToFull)
  bot.command('last', showLastTrips)

  bot.command('stats', context => showStats(context, database, context.match?.trim()))

  bot.command('day', context => report(context, database, 'daily'))
  bot.command('week', context => report(context, database, 'weekly'))
  bot.command('month', context => report(context, database, 'monthly'))

  bot.hears(buttonLabels.status, showStatus)
  bot.hears(buttonLabels.fuel, showFuelToFull)
  bot.hears(buttonLabels.last, showLastTrips)
  bot.hears(buttonLabels.stats, context => showStats(context, database))
  bot.hears(buttonLabels.day, context => report(context, database, 'daily'))
  bot.hears(buttonLabels.week, context => report(context, database, 'weekly'))
  bot.hears(buttonLabels.month, context => report(context, database, 'monthly'))

  // Stepping a month redraws the message in place rather than adding another one,
  // so browsing back through the year leaves a single card in the chat.
  bot.callbackQuery(/^stats:(\d{4}-\d{2})$/, async (context) => {
    const [, month] = context.match as RegExpMatchArray
    const stats = await buildMonthStats(database, month)
    if (!stats) return context.answerCallbackQuery('Такого месяца нет')
    await context.answerCallbackQuery()
    try {
      await context.editMessageText(stats.text, { ...replyOptions, reply_markup: stats.keyboard })
    } catch (error) {
      // Telegram rejects an edit that changes nothing; the card is already right.
      if (!/message is not modified/i.test(error instanceof Error ? error.message : '')) throw error
    }
  })
}
