import { and, count, desc, eq, gte, inArray, isNotNull, lt, notExists, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { engineSessions, refuelEvents, refuelReceipts, trips, vehicleSnapshots } from '../../db/schema'
import { idleSummary } from '../../metrics/idle'

export type ReportPeriod = 'daily' | 'weekly' | 'monthly'

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const REPORT_HOUR = 15

const periodTitle: Record<ReportPeriod, string> = {
  daily: 'Ежедневный отчёт',
  weekly: 'Еженедельный отчёт',
  monthly: 'Ежемесячный отчёт'
}

function fromMoscowCalendar(year: number, month: number, day: number, hour = 0) {
  return new Date(Date.UTC(year, month, day, hour) - MOSCOW_OFFSET_MS)
}

function moscowCalendar(now: Date) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekDay: shifted.getUTCDay()
  }
}

export function completedReportRange(period: ReportPeriod, now = new Date()) {
  const calendar = moscowCalendar(now)
  const today = fromMoscowCalendar(calendar.year, calendar.month, calendar.day)
  if (period === 'daily') return { start: new Date(today.getTime() - DAY_MS), end: today }
  if (period === 'weekly') {
    const daysSinceMonday = (calendar.weekDay + 6) % 7
    const end = new Date(today.getTime() - daysSinceMonday * DAY_MS)
    return { start: new Date(end.getTime() - 7 * DAY_MS), end }
  }
  const end = fromMoscowCalendar(calendar.year, calendar.month, 1)
  return { start: fromMoscowCalendar(calendar.year, calendar.month - 1, 1), end }
}

export function nextReportRun(period: ReportPeriod, now = new Date()) {
  const calendar = moscowCalendar(now)
  if (period === 'daily') {
    let candidate = fromMoscowCalendar(calendar.year, calendar.month, calendar.day, REPORT_HOUR)
    if (candidate <= now) candidate = new Date(candidate.getTime() + DAY_MS)
    return candidate
  }
  if (period === 'weekly') {
    const daysUntilMonday = (8 - calendar.weekDay) % 7
    let candidate = fromMoscowCalendar(calendar.year, calendar.month, calendar.day + daysUntilMonday, REPORT_HOUR)
    if (candidate <= now) candidate = new Date(candidate.getTime() + 7 * DAY_MS)
    return candidate
  }
  let candidate = fromMoscowCalendar(calendar.year, calendar.month, 1, REPORT_HOUR)
  if (candidate <= now) candidate = fromMoscowCalendar(calendar.year, calendar.month + 1, 1, REPORT_HOUR)
  return candidate
}

const decimal = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 })
const preciseDecimal = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dateOnly = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })
const dateTime = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function duration(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes))
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  if (!hours) return `${rest} мин`
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`
}

function rangeLabel(start: Date, end: Date, period: ReportPeriod) {
  const inclusiveEnd = new Date(end.getTime() - 1)
  if (period === 'daily') return dateOnly.format(start)
  return `${dateOnly.format(start)} — ${dateOnly.format(inclusiveEnd)}`
}

function battery(value: number | null, type: string | null) {
  if (value == null) return 'нет данных'
  return type === 'percent' ? `${integer.format(value)}%` : `${decimal.format(value)} В`
}

function engineState(online: boolean | null, ignition: boolean | null) {
  if (online === false) return 'не в сети'
  if (ignition === true) return 'двигатель работает'
  if (ignition === false) return 'двигатель выключен'
  return 'состояние неизвестно'
}

// Idling moves the tank by less than the sensor's half-litre step, so the litres
// are inferred from a rate measured across every stationary session on record
// rather than read off the gauge. The second line names that rate and says
// whether it is the car's own or a stand-in, because the roubles are only as
// good as it is.
function idleLines(idle: Awaited<ReturnType<typeof idleSummary>>) {
  if (!(idle.minutes > 0)) return ['• Прогревов не было']
  const spent = idle.cost == null ? '' : ` · ${money.format(idle.cost)}`
  const cold = idle.coldMinutes > 0 ? ` · на холодную ${duration(idle.coldMinutes)}` : ''
  const armed = idle.armedMinutes > 0 ? ` · перед поездкой ${duration(idle.armedMinutes)}` : ''
  // Caught by the engine-hour counter alone, so it has no session to be counted in.
  const untracked = idle.untrackedMinutes > 0.5 ? ` · мимо сессий ${duration(idle.untrackedMinutes)}` : ''
  const rate = `${preciseDecimal.format(idle.rate.litresPerHour)} л/ч`
  return [
    `• Прогревы: ${integer.format(idle.sessions)} · ${duration(idle.minutes)} · ${decimal.format(idle.litres)} л${spent}${cold}${armed}${untracked}`,
    `• Холостой ход: ${rate} ${idle.rate.source === 'measured' ? 'по замерам' : '(оценка)'}`
      + ` · ${idle.pricePerLitre == null ? 'цена литра неизвестна' : `${preciseDecimal.format(idle.pricePerLitre)} ₽/л`}`
  ]
}

export async function buildReport(database: Database, period: ReportPeriod, now = new Date()) {
  const vehicle = await database.query.vehicles.findFirst()
  const { start, end } = completedReportRange(period, now)
  if (!vehicle) return `🚗 <b>${periodTitle[period]}</b>\n<i>${rangeLabel(start, end, period)}</i>\n\nДанных об автомобиле пока нет.`

  const bounds = and(gte(trips.startedAt, start), lt(trips.startedAt, end))
  const [tripSummary] = await database.select({
    count: count(),
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    fuel: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
    minutes: sql<number>`coalesce(sum(case when ${trips.endedAt} is not null then (${trips.endedAt} - ${trips.startedAt}) / 60000.0 else 0 end), 0)`
  }).from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false), bounds))

  const [engineSummary] = await database.select({ sessions: count() })
    .from(engineSessions).where(and(
      eq(engineSessions.vehicleId, vehicle.id), eq(engineSessions.isOpen, false),
      gte(engineSessions.startedAt, start), lt(engineSessions.startedAt, end)
    ))
  const idle = await idleSummary(database, vehicle.id, start, end)

  const [refuelSummary] = await database.select({
    count: count(),
    litres: sql<number>`coalesce(sum(${refuelEvents.litresAdded}), 0)`,
    amount: sql<number>`sum(${refuelEvents.totalAmount})`
  }).from(refuelEvents).where(and(
    eq(refuelEvents.vehicleId, vehicle.id), gte(refuelEvents.detectedAt, start), lt(refuelEvents.detectedAt, end)
  ))

  const [unconfirmedSummary] = await database.select({ count: count() })
    .from(refuelEvents).where(and(
      eq(refuelEvents.vehicleId, vehicle.id), gte(refuelEvents.detectedAt, start), lt(refuelEvents.detectedAt, end),
      notExists(database.select({ one: sql`1` }).from(refuelReceipts).where(and(
        eq(refuelReceipts.refuelEventId, refuelEvents.id),
        inArray(refuelReceipts.matchStatus, ['auto', 'manual'])
      )))
    ))

  const [batterySummary] = await database.select({
    min: sql<number>`min(${vehicleSnapshots.battery})`,
    max: sql<number>`max(${vehicleSnapshots.battery})`,
    average: sql<number>`avg(${vehicleSnapshots.battery})`
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicle.id), isNotNull(vehicleSnapshots.battery),
    gte(vehicleSnapshots.ts, start), lt(vehicleSnapshots.ts, end)
  ))
  const snapshot = await database.query.vehicleSnapshots.findFirst({
    where: and(eq(vehicleSnapshots.vehicleId, vehicle.id), lt(vehicleSnapshots.ts, end)),
    orderBy: desc(vehicleSnapshots.ts)
  })

  const distance = Number(tripSummary?.distance || 0)
  const fuel = Number(tripSummary?.fuel || 0)
  const consumption = distance > 0 && fuel > 0 ? fuel / distance * 100 : null
  const refuelAmount = refuelSummary?.amount == null ? null : Number(refuelSummary.amount)
  const unconfirmed = Number(unconfirmedSummary?.count || 0)
  const batteryType = snapshot?.batteryType || null
  const batteryLine = batterySummary?.average == null
    ? '• Нет измерений за период'
    : `• Среднее: ${battery(Number(batterySummary.average), batteryType)} · мин. ${battery(Number(batterySummary.min), batteryType)} · макс. ${battery(Number(batterySummary.max), batteryType)}`
  const stateLines = snapshot
    ? [`• ${engineState(snapshot.online, snapshot.ignition)} · пробег ${snapshot.mileage == null ? '—' : `${decimal.format(snapshot.mileage)} км`}`,
        `• Топливо: ${snapshot.fuel == null ? '—' : `${decimal.format(snapshot.fuel)} л`} · АКБ: ${battery(snapshot.battery, snapshot.batteryType)}`,
        `• Данные на ${dateTime.format(snapshot.activityTs || snapshot.ts)}`]
    : ['• Снимков состояния пока нет']

  return [
    `🚗 <b>${escapeHtml(vehicle.alias)} · ${periodTitle[period]}</b>`,
    `<i>${rangeLabel(start, end, period)}</i>`,
    '',
    '🛣 <b>Поездки</b>',
    `• ${integer.format(Number(tripSummary?.count || 0))} поездок · ${decimal.format(distance)} км`,
    `• В пути: ${duration(Number(tripSummary?.minutes || 0))}`,
    `• Израсходовано: ${decimal.format(fuel)} л${consumption == null ? '' : ` · ${decimal.format(consumption)} л/100 км`}`,
    '',
    '🔥 <b>Двигатель</b>',
    `• Сессий: ${integer.format(Number(engineSummary?.sessions || 0))}`,
    ...idleLines(idle),
    '',
    '⛽ <b>Заправки</b>',
    `• ${integer.format(Number(refuelSummary?.count || 0))} · ${decimal.format(Number(refuelSummary?.litres || 0))} л${refuelAmount == null ? '' : ` · ${money.format(refuelAmount)}`}`,
    ...(unconfirmed > 0 ? [`• Без чека: ${integer.format(unconfirmed)} — пришлите фото сюда`] : []),
    '',
    '🔋 <b>АКБ за период</b>',
    batteryLine,
    '',
    '📍 <b>Состояние к концу периода</b>',
    ...stateLines
  ].join('\n')
}
