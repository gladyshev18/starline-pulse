import { and, asc, eq, gt, gte, isNotNull, isNull, lte } from 'drizzle-orm'
import { GrammyError, InlineKeyboard, type Bot } from 'grammy'
import type { Database } from '../../db/client'
import { jobs, removedTrips, trips } from '../../db/schema'
import { guessDriver } from '../../shared/driver-guess'
import { allowedRecipients, recipientName, type Recipient } from './recipients'

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

type Trip = typeof trips.$inferSelect

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
//
// Вероятный водитель, если он есть, уходит наверх и занимает отдельный ряд.
// Порядок остальных при этом не меняется: кнопки, которые прыгают с места на
// место, — верный способ записать не того, кто вёл.
export function driverKeyboard(
  tripId: number,
  drivers: Pick<Recipient, 'id' | 'username' | 'firstName'>[],
  likely: string | null = null
) {
  const keyboard = new InlineKeyboard()
  const suggested = likely ? drivers.find(driver => recipientName(driver) === likely) : undefined
  if (suggested) keyboard.text(`✅ ${recipientName(suggested)}`, `trip:driver:${tripId}:${suggested.id}`).row()

  const rest = drivers.filter(driver => driver !== suggested)
  rest.forEach((driver, index) => {
    keyboard.text(recipientName(driver), `trip:driver:${tripId}:${driver.id}`)
    if (index % 2 === 1) keyboard.row()
  })
  if (rest.length % 2 === 1) keyboard.row()
  return keyboard.text('Пропустить', `trip:driver:${tripId}:${SKIP_ANSWER}`)
}

// Спрашивать некого, пока в чате никого нет: кнопка «Пропустить» в одиночку
// ничего не сообщает, поэтому клавиатуры просто не будет.
export async function buildDriverKeyboard(database: Database, tripId: number, startedAt?: Date) {
  const drivers = await allowedRecipients(database)
  if (!drivers.length) return null
  return driverKeyboard(tripId, drivers, startedAt ? await likelyDriver(database, startedAt) : null)
}

// История берётся за всё время и без ограничения по машине: водитель — свойство
// привычки, а не месяца, и чем длиннее история, тем реже догадка промахивается.
export async function likelyDriver(database: Database, startedAt: Date) {
  const rows = await database.select({ driver: trips.driver, startedAt: trips.startedAt })
    .from(trips).where(isNotNull(trips.driver))
  const moscow = (value: Date) => new Date(value.getTime() + MOSCOW_OFFSET_MS)
  const history = rows
    .filter((row): row is { driver: string, startedAt: Date } => Boolean(row.driver))
    .map(row => ({
      driver: row.driver,
      weekday: moscow(row.startedAt).getUTCDay(),
      hour: moscow(row.startedAt).getUTCHours()
    }))
  const at = moscow(startedAt)
  return guessDriver(history, { weekday: at.getUTCDay(), hour: at.getUTCHours() })?.driver ?? null
}

// Поездка, о которой спрашивало сообщение. Номер в кнопке — тот, что был на
// момент отправки, а разбор журнала правит границы задним числом и может
// заменить запись целиком. Сообщение в чате при этом остаётся, и ответ на него
// должен доехать до той поездки, которая заняла место прежней.
export async function resolveTrip(database: Database, tripId: number) {
  const trip = await database.query.trips.findFirst({ where: eq(trips.id, tripId) })
  if (trip) return trip
  const removed = await database.query.removedTrips.findFirst({ where: eq(removedTrips.tripId, tripId) })
  if (!removed?.endedAt) return null
  // Преемник — тот, кто накрывает то же время. Границы двигаются на минуты, в
  // чужие сутки поездка от этого не переезжает.
  return await database.query.trips.findFirst({
    where: and(
      eq(trips.vehicleId, removed.vehicleId),
      eq(trips.isOpen, false),
      lte(trips.startedAt, removed.endedAt),
      gt(trips.endedAt, removed.startedAt)
    )
  }) ?? null
}

// Вопрос уходит ровно один раз на поездку, и отметка об этом живёт в самой
// поездке. Иначе спрашивать пришлось бы по факту закрытия — а закрытая опросом
// запись до отправки может не дожить: пересчёт километров сносит прогревы и
// дубли с прежними границами, и вопрос уезжал в чат уже без кнопок.
export async function askDriver(database: Database, trip: Trip) {
  if (trip.isOpen || trip.driverAskedAt || trip.driver) return false
  await database.insert(jobs).values({ type: 'telegram:notify', payload: JSON.stringify({
    html: true,
    text: tripCompletedText(trip),
    tripId: trip.id
  }) })
  await database.update(trips).set({ driverAskedAt: new Date() }).where(eq(trips.id, trip.id))
  return true
}

// Проход по всем закрытым поездкам, о которых ещё не спрашивали. Поводов
// пройтись два: закрытие поездки опросом и разбор журнала сигнализации,
// который заводит дороги, проспанные опросом целиком, — раньше о них не
// спрашивали вовсе.
export async function askAboutClosedTrips(database: Database, vehicleId: number, since: Date) {
  const pending = await database.select().from(trips).where(and(
    eq(trips.vehicleId, vehicleId),
    eq(trips.isOpen, false),
    isNull(trips.driverAskedAt),
    gte(trips.endedAt, since)
  )).orderBy(asc(trips.startedAt))
  let asked = 0
  for (const trip of pending) if (await askDriver(database, trip)) asked++
  return asked
}

function isNotModified(error: unknown) {
  return error instanceof GrammyError && error.description.includes('message is not modified')
}

export function registerTripDriverHandlers(bot: Bot, database: Database) {
  bot.callbackQuery(new RegExp(`^trip:driver:(\\d+):(\\d+|${SKIP_ANSWER})$`), async (context) => {
    const [, rawTripId, answer] = context.match as RegExpMatchArray
    const trip = await resolveTrip(database, Number(rawTripId))
    if (!trip) return context.answerCallbackQuery('Поездка не найдена')

    let driver: string | null = null
    if (answer !== SKIP_ANSWER) {
      const recipient = (await allowedRecipients(database)).find(item => item.id === Number(answer))
      if (!recipient) return context.answerCallbackQuery('Этого водителя больше нет в списке')
      driver = recipientName(recipient)
    }

    const [updated] = await database.update(trips).set({ driver }).where(eq(trips.id, trip.id)).returning()
    await context.answerCallbackQuery(driver ? `Записал: ${driver}` : 'Пропустил')

    // Кнопки остаются на месте: промахнуться по соседнему имени легко, и
    // единственный способ исправить это — нажать другое. Номер в них теперь
    // указывает на найденную поездку, чтобы следующее нажатие не искало
    // прежнюю заново.
    try {
      await context.editMessageText(tripCompletedText(updated || { ...trip, driver }, { skipped: !driver }), {
        parse_mode: 'HTML',
        reply_markup: driverKeyboard(trip.id, await allowedRecipients(database))
      })
    } catch (error) {
      // Повторное нажатие того же имени не меняет ни текст, ни кнопки, и
      // Telegram отвечает на это ошибкой. Ответ пользователю уже отправлен.
      if (!isNotModified(error)) throw error
    }
  })
}
