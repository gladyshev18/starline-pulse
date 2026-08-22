import { InlineKeyboard } from 'grammy'
import type { Database } from '../../db/client'
import { monthStatistics, type MonthStatistics } from '../../metrics/statistics'
import { hasNamedDriver } from '../../shared/drivers'
import { currentMoscowMonth, monthTitle, moscowMonthRange, shiftMonth } from '../../shared/moscow-month'
import { plural } from '../../shared/plural'
import { barChart, dayScale, sparkline, type BarRow } from '../../shared/text-chart'

const decimal = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 })
const preciseDecimal = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const monthOnly = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' })

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function number(value: number | null | undefined, suffix: string) {
  return value == null ? '—' : `${decimal.format(value)} ${suffix}`
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const name = monthOnly.format(new Date(Date.UTC(year!, monthNumber! - 1, 1)))
  return name[0]!.toUpperCase() + name.slice(1)
}

// The tank balance counts warm-ups and the litres no trip ever claimed, so it
// reads higher than the sum of the trips. Spelling the arithmetic out is what
// keeps that difference from looking like an error — the same note the page
// carries under the litres.
function fuelNote(totals: MonthStatistics['totals']) {
  if (totals.fuelSource !== 'balance') return 'Литры — по завершённым поездкам'
  return `Литры — по баку: ${number(totals.tankStart, 'л')} → ${number(totals.tankEnd, 'л')}, заправлено ${number(totals.refuelled, 'л')}`
}

function block(title: string, lines: string[]) {
  return [`<b>${title}</b>`, `<pre>${escapeHtml(lines.join('\n'))}</pre>`]
}

// Whole weeks of the month as it is numbered, not as the calendar falls: the
// first seven days, then the next seven. A month split by weekday would put a
// three-day stub at each end and make two months impossible to compare.
function weekRows(daily: MonthStatistics['daily'], daysShown: number): BarRow[] {
  const rows: BarRow[] = []
  for (let from = 0; from < daysShown; from += 7) {
    const chunk = daily.slice(from, Math.min(from + 7, daysShown))
    const distance = chunk.reduce((sum, item) => sum + item.distance, 0)
    rows.push({
      label: `${String(from + 1).padStart(2, '0')}–${String(from + chunk.length).padStart(2, '0')}`,
      value: distance,
      note: `${integer.format(distance)} км`
    })
  }
  return rows
}

function dailyChart(stats: MonthStatistics, daysShown: number) {
  const days = stats.daily.slice(0, daysShown)
  const best = days.reduce((top, item) => item.distance > (top?.distance || 0) ? item : top, days[0])
  const idle = days.filter(item => !(item.distance > 0)).length
  const lines = [sparkline(days.map(item => item.distance)), dayScale(daysShown)]
  const notes = [
    best && best.distance > 0 ? `максимум ${decimal.format(best.distance)} км ${Number(best.day.slice(-2))}-го` : null,
    idle > 0 ? `без поездок ${integer.format(idle)} ${plural(idle, 'день', 'дня', 'дней')}` : null
  ].filter(Boolean)
  return [
    ...block('Пробег по дням', lines),
    ...(notes.length ? [`<i>${notes.join(' · ')}</i>`] : [])
  ]
}

function speedChart(stats: MonthStatistics) {
  const rows = stats.bySpeed.filter(item => item.trips > 0 && item.consumption != null)
  if (rows.length < 2) return []
  return block('Куда уходит бензин, л/100 км', barChart(rows.map(item => ({
    label: item.label,
    value: item.consumption || 0,
    note: decimal.format(item.consumption || 0)
  }))))
}

// Столбики — километры, а расход вынесен в подпись: у водителей он различается
// на десятые доли, и такой бар рядом с соседним выглядел бы одинаковым. Литры
// тут по поездкам, поэтому в сумме они меньше израсходованного за месяц — про
// это говорит общая подпись под сообщением.
function driverChart(stats: MonthStatistics) {
  const rows = stats.byDriver
  if (!hasNamedDriver(rows)) return []
  const consumption = rows
    .filter(row => row.consumption != null)
    .map(row => `${row.driver || 'не указан'} — ${decimal.format(row.consumption!)}`)
  return [
    ...block('За рулём, км', barChart(rows.map(row => ({
      label: row.driver || 'Не указан',
      value: row.distance,
      note: `${integer.format(row.distance)} км`
    })))),
    ...(consumption.length ? [`<i>Расход, л/100 км: ${escapeHtml(consumption.join(' · '))}</i>`] : [])
  ]
}

function odometerLine(stats: MonthStatistics) {
  const first = stats.odometer[0]
  const last = stats.odometer.at(-1)
  if (!first || !last || last.mileage <= first.mileage) return []
  const grown = Math.max(0, last.mileage - first.mileage)
  return [`🧭 Одометр: ${integer.format(first.mileage)} → ${integer.format(last.mileage)} км · +${integer.format(grown)}`]
}

function ambientLine(stats: MonthStatistics) {
  const { average, min, max } = stats.ambient
  if (average == null || min == null || max == null) return []
  return [`🌡 Ночью: ${integer.format(average)} °C · от ${integer.format(min)} до ${integer.format(max)}`]
}

export function statsKeyboard(month: string, currentMonth: string) {
  const previous = shiftMonth(month, -1)
  const next = shiftMonth(month, 1)
  const keyboard = new InlineKeyboard().text(`◀ ${monthLabel(previous)}`, `stats:${previous}`)
  if (next <= currentMonth) keyboard.text(`${monthLabel(next)} ▶`, `stats:${next}`)
  if (month !== currentMonth) keyboard.row().text('🔄 Текущий месяц', `stats:${currentMonth}`)
  return keyboard
}

export function buildStatsMessage(stats: MonthStatistics, now = new Date()) {
  const { totals } = stats
  const isCurrent = stats.month === stats.currentMonth
  // A month still running has empty days ahead of today, and drawing them would
  // read as a fortnight of standing still rather than as a month not yet over.
  const daysShown = isCurrent
    ? Math.min(stats.daily.length, new Date(now.getTime() + MOSCOW_OFFSET_MS).getUTCDate())
    : stats.daily.length
  const subtitle = isCurrent ? `${monthTitle(stats.month)} · по ${daysShown}-е число` : monthTitle(stats.month)

  const head = [
    `📊 <b>Статистика${stats.vehicle ? ` · ${escapeHtml(stats.vehicle.alias)}` : ''}</b>`,
    `<i>${subtitle}</i>`,
    '',
    `🛣 Пробег: <b>${number(totals.distance, 'км')}</b> · ${integer.format(totals.trips)} ${plural(totals.trips, 'поездка', 'поездки', 'поездок')}`,
    `⛽ Израсходовано: <b>${number(totals.fuelUsed, 'л')}</b>`,
    `📉 Расход: <b>${totals.consumption == null ? '—' : `${decimal.format(totals.consumption)} л/100 км`}</b>`,
    `💰 Километр: <b>${totals.costPerKm == null ? '—' : money.format(totals.costPerKm)}</b>`
      + `${totals.pricePerLitre == null ? ' · чеков нет' : ` · бензин ${preciseDecimal.format(totals.pricePerLitre)} ₽/л`}`,
    ...(totals.refuels > 0 ? [`🛢 Заправки: ${integer.format(totals.refuels)} · ${number(totals.refuelled, 'л')}`] : []),
    ...odometerLine(stats),
    ...ambientLine(stats)
  ]

  if (!(totals.distance > 0) && !(totals.fuelUsed > 0)) {
    return [...head, '', '<i>За этот месяц поездок пока нет.</i>'].join('\n')
  }

  const drivers = driverChart(stats)
  const speed = speedChart(stats)
  return [
    ...head,
    '',
    ...dailyChart(stats, daysShown),
    '',
    ...block('По неделям, км', barChart(weekRows(stats.daily, daysShown))),
    ...(drivers.length ? ['', ...drivers] : []),
    ...(speed.length ? ['', ...speed] : []),
    '',
    `<i>${fuelNote(totals)}</i>`
  ].join('\n')
}

export async function buildMonthStats(database: Database, month?: string | null, now = new Date()) {
  const currentMonth = currentMoscowMonth(now)
  const range = moscowMonthRange(month ?? currentMonth, now)
  if (!range) return null
  const stats = await monthStatistics(database, range, now)
  return { text: buildStatsMessage(stats, now), keyboard: statsKeyboard(range.month, currentMonth) }
}
