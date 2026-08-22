import { eq } from 'drizzle-orm'
import { GrammyError, InlineKeyboard, type Bot } from 'grammy'
import type { Database } from '../../db/client'
import { trips } from '../../db/schema'
import { allowedRecipients, recipientName, type Recipient } from './recipients'

export type TripSummary = {
  distance: number | null
  fuelUsed: number | null
  driver: string | null
}

export const SKIP_ANSWER = 'skip'

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function format(value: number | null) {
  return value == null ? '—' : value.toFixed(1)
}

// Одно и то же сообщение рисуется дважды: когда поездка закрылась и когда на
// вопрос ответили. Поэтому текст собирается здесь, а не в двух местах.
export function tripCompletedText(trip: TripSummary, options: { skipped?: boolean } = {}) {
  const consumption = trip.distance && trip.fuelUsed != null ? trip.fuelUsed / trip.distance * 100 : null
  const answer = trip.driver
    ? `🧑 За рулём: <b>${escapeHtml(trip.driver)}</b>`
    : options.skipped ? '🧑 За рулём: не указан' : '🧑 Кто был за рулём?'
  return [
    '🏁 <b>Поездка завершена</b>',
    '',
    `🛣 Расстояние: ${format(trip.distance)} км`,
    `⛽ Топливо: ${format(trip.fuelUsed)} л`,
    `📊 Расход: ${format(consumption)} л/100 км`,
    '',
    answer
  ].join('\n')
}

// Имена по двое в ряд: длинное имя в одиночку растягивает кнопку на всю ширину
// и рядом с ним «Пропустить» уже не помещается.
export function driverKeyboard(tripId: number, drivers: Pick<Recipient, 'id' | 'username' | 'firstName'>[]) {
  const keyboard = new InlineKeyboard()
  drivers.forEach((driver, index) => {
    keyboard.text(recipientName(driver), `trip:driver:${tripId}:${driver.id}`)
    if (index % 2 === 1) keyboard.row()
  })
  if (drivers.length % 2 === 1) keyboard.row()
  return keyboard.text('Пропустить', `trip:driver:${tripId}:${SKIP_ANSWER}`)
}

// Спрашивать некого, пока в чате никого нет: кнопка «Пропустить» в одиночку
// ничего не сообщает, поэтому клавиатуры просто не будет.
export async function buildDriverKeyboard(database: Database, tripId: number) {
  const drivers = await allowedRecipients(database)
  return drivers.length ? driverKeyboard(tripId, drivers) : null
}

function isNotModified(error: unknown) {
  return error instanceof GrammyError && error.description.includes('message is not modified')
}

export function registerTripDriverHandlers(bot: Bot, database: Database) {
  bot.callbackQuery(new RegExp(`^trip:driver:(\\d+):(\\d+|${SKIP_ANSWER})$`), async (context) => {
    const [, rawTripId, answer] = context.match as RegExpMatchArray
    const tripId = Number(rawTripId)
    const trip = await database.query.trips.findFirst({ where: eq(trips.id, tripId) })
    if (!trip) return context.answerCallbackQuery('Поездка не найдена')

    let driver: string | null = null
    if (answer !== SKIP_ANSWER) {
      const recipient = (await allowedRecipients(database)).find(item => item.id === Number(answer))
      if (!recipient) return context.answerCallbackQuery('Этого водителя больше нет в списке')
      driver = recipientName(recipient)
    }

    const [updated] = await database.update(trips).set({ driver }).where(eq(trips.id, tripId)).returning()
    await context.answerCallbackQuery(driver ? `Записал: ${driver}` : 'Пропустил')

    // Кнопки остаются на месте: промахнуться по соседнему имени легко, и
    // единственный способ исправить это — нажать другое.
    try {
      await context.editMessageText(tripCompletedText(updated || { ...trip, driver }, { skipped: !driver }), {
        parse_mode: 'HTML',
        reply_markup: driverKeyboard(tripId, await allowedRecipients(database))
      })
    } catch (error) {
      // Повторное нажатие того же имени не меняет ни текст, ни кнопки, и
      // Telegram отвечает на это ошибкой. Ответ пользователю уже отправлен.
      if (!isNotModified(error)) throw error
    }
  })
}
