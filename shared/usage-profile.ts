// Когда машиной пользуются. Ни одного нового поля для этого не нужно: время
// начала поездки известно с точностью до секунды из журнала сигнализации, а
// больше ничего и не требуется.

// Понедельник первым — как в календаре. `strftime('%w')` считает от воскресенья,
// и порядок восстанавливается здесь, а не в SQL, чтобы запрос остался обычной
// группировкой.
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const

export function weekdayIndex(sqliteWeekday: number) {
  return (sqliteWeekday + 6) % 7
}

export interface UsageRow {
  // 0 — воскресенье, как отдаёт SQLite.
  weekday: number
  hour: number
  trips: number
  distance: number
}

export interface UsageCell {
  weekday: number
  hour: number
  trips: number
  distance: number
}

export interface UsageProfile {
  cells: UsageCell[]
  byHour: Array<{ hour: number, trips: number, distance: number }>
  byWeekday: Array<{ weekday: number, label: string, trips: number, distance: number }>
  // Часы, за пределами которых машина не выезжала ни разу. Рисовать все двадцать
  // четыре столбца, из которых половина пустая всегда, — значит отдать половину
  // ширины ночи, в которую никто не ездит.
  fromHour: number | null
  toHour: number | null
  busiestHour: number | null
  busiestWeekday: number | null
  trips: number
  distance: number
}

export function summariseUsage(rows: UsageRow[]): UsageProfile {
  const cells: UsageCell[] = rows.map(row => ({
    weekday: weekdayIndex(row.weekday),
    hour: row.hour,
    trips: row.trips,
    distance: row.distance
  }))

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, trips: 0, distance: 0 }))
  const byWeekday = WEEKDAYS.map((label, weekday) => ({ weekday, label, trips: 0, distance: 0 }))
  for (const cell of cells) {
    const hour = byHour[cell.hour]
    if (hour) { hour.trips += cell.trips; hour.distance += cell.distance }
    const weekday = byWeekday[cell.weekday]
    if (weekday) { weekday.trips += cell.trips; weekday.distance += cell.distance }
  }

  const used = byHour.filter(item => item.trips > 0)
  const pickBusiest = <T extends { trips: number }>(items: T[]) => items.reduce<T | null>(
    (found, item) => item.trips > 0 && (!found || item.trips > found.trips) ? item : found,
    null
  )

  return {
    cells,
    byHour,
    byWeekday,
    fromHour: used[0]?.hour ?? null,
    toHour: used.at(-1)?.hour ?? null,
    busiestHour: pickBusiest(byHour)?.hour ?? null,
    busiestWeekday: pickBusiest(byWeekday)?.weekday ?? null,
    trips: cells.reduce((sum, cell) => sum + cell.trips, 0),
    distance: cells.reduce((sum, cell) => sum + cell.distance, 0)
  }
}

export interface StandstillInput {
  // Промежутки между концом одной поездки и началом следующей, в часах.
  gaps: number[]
  daysWithTrips: number
  daysCovered: number
}

export interface Standstill {
  averageHours: number | null
  longestHours: number | null
  daysWithTrips: number
  daysCovered: number
  idleDays: number
}

// Сколько машина стоит между поездками. Среднее и максимум отвечают на разные
// вопросы: среднее — насколько плотно она нужна, максимум — можно ли без неё
// вообще обойтись.
export function summariseStandstill(input: StandstillInput): Standstill {
  const gaps = input.gaps.filter(value => Number.isFinite(value) && value >= 0)
  return {
    averageHours: gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null,
    longestHours: gaps.length ? Math.max(...gaps) : null,
    daysWithTrips: input.daysWithTrips,
    daysCovered: input.daysCovered,
    idleDays: Math.max(0, input.daysCovered - input.daysWithTrips)
  }
}
