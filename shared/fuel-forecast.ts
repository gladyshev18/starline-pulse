// На сколько хватит того, что в баке.
//
// Километры здесь — единственное честное число: литры делить на расход можно, и
// от привычек это не зависит. А вот дни зависят целиком. Средний день августа
// вышел 58,6 км, но в тихий день машина проезжает тринадцать, а в активный сто
// тридцать — разброс в десять раз, и «хватит на 5,2 дня» такое среднее описать
// не может.
//
// Поэтому дни считаются не одним числом, а тремя, и берутся из самого
// распределения: сколько дней выйдет, если ездить как в тихие дни, как обычно и
// как в активные.

export interface RangeInput {
  litres: number | null
  // Литров на сто километров — за тот срок, за который его имеет смысл мерить.
  consumption: number | null
  // Пробег по дням, когда машина вообще выезжала. Дни простоя сюда не входят:
  // они растянули бы прогноз ровно на то время, когда бензин не тратится, и
  // «хватит на месяц» означало бы «месяц не ездить».
  dailyDistances: number[]
  tripDistances: number[]
}

export interface RangeForecast {
  km: number | null
  // Дни поездок, а не календарные: см. `dailyDistances`.
  days: { quiet: number, typical: number, busy: number } | null
  trips: { typical: number, typicalCount: number, long: number, longCount: number } | null
}

// Меньше этого история дней не описывает привычку, а перечисляет случайности.
export const MIN_DAYS = 7
export const MIN_TRIPS = 10

export function percentile(values: number[], share: number) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((left, right) => left - right)
  if (!sorted.length) return null
  const position = (sorted.length - 1) * share
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

export function forecastRange(input: RangeInput): RangeForecast {
  const km = input.litres != null && input.consumption != null && input.consumption > 0 && input.litres > 0
    ? input.litres / input.consumption * 100
    : null
  if (km == null) return { km: null, days: null, trips: null }

  const days = input.dailyDistances.length >= MIN_DAYS
    ? {
        // Тихий день расходует меньше, поэтому и дней из него выходит больше:
        // нижний квартиль пробега даёт верхнюю оценку срока.
        quiet: km / percentile(input.dailyDistances, 0.25)!,
        typical: km / percentile(input.dailyDistances, 0.5)!,
        busy: km / percentile(input.dailyDistances, 0.75)!
      }
    : null

  const typical = input.tripDistances.length >= MIN_TRIPS ? percentile(input.tripDistances, 0.5) : null
  const long = input.tripDistances.length >= MIN_TRIPS ? percentile(input.tripDistances, 0.9) : null

  return {
    km,
    days,
    // «Хватит на три поездки к родителям» понятнее любых дней: это единица, в
    // которой человек и планирует.
    trips: typical && long ? {
      typical,
      typicalCount: km / typical,
      long,
      longCount: km / long
    } : null
  }
}
