import { averageSpeed, bucketForSpeed, type ConsumptionTrip, type SpeedBucketName } from './consumption'
import { FUEL_SENSOR_STEP_LITRES } from './fuel'

// Худшая ошибка расхода одной поездки, в л/100 км. Литры — разность двух
// показаний, каждое округлено к шагу датчика, поэтому разность промахивается
// не больше чем на целый шаг. Для месячных сумм такую границу брать незачем:
// там ошибки складываются и гасят друг друга, и `fuelSumUncertainty` считает
// именно это. Но у отдельной поездки усреднять нечего, и честная граница —
// весь шаг целиком.
export function consumptionErrorBound(distance: number | null) {
  if (distance == null || !(distance > 0)) return null
  return FUEL_SENSOR_STEP_LITRES / distance * 100
}

// Доля, при которой измерение перестаёт быть измерением. Треть означает, что
// «12 л/100 км» на самом деле «от 8 до 16»: соседние корзины скорости лежат
// ближе друг к другу, чем такой интервал, и класть в них подобные поездки
// нельзя.
export const MAX_ERROR_SHARE = 1 / 3

// Ниже этой средней скорости расход поездки описывает не дорогу, а стояние:
// двигатель на холостых ест примерно одинаково в минуту, поэтому километров
// становится мало, а литров — нет. Это не ошибка данных, но и не тот расход,
// который имеет смысл сравнивать с трассой.
export const MIN_DRIVING_SPEED = 15

// Ниже этого числа поездок медиана корзины сама шумит сильнее, чем отклонение,
// которое ей полагается ловить.
export const MIN_BUCKET_SAMPLES = 5

export type ConsumptionDoubt = 'short' | 'crawl'

export interface TripConsumption extends ConsumptionTrip {
  id: number
}

export interface TripConsumptionQuality {
  id: number
  consumption: number | null
  errorBound: number | null
  speed: number | null
  bucket: SpeedBucketName | null
  // Почему числу нельзя верить. Пусто — значит поездка измерена нормально.
  doubts: ConsumptionDoubt[]
  // Отклонение от медианы своей корзины, л/100 км. Есть только у измеренных
  // нормально поездок: у остальных отклоняется не машина, а округление.
  deviation: number | null
  outlier: boolean
}

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

// Медиана абсолютных отклонений — разброс корзины, устойчивый к тем самым
// выбросам, которые ищутся. Среднеквадратичное для этого не годится: один
// выброс раздувает его настолько, что перестаёт считаться выбросом сам.
function medianAbsoluteDeviation(values: number[], centre: number) {
  return median(values.map(value => Math.abs(value - centre)))
}

function consumptionOf(trip: ConsumptionTrip) {
  if (trip.distance == null || !(trip.distance > 0) || trip.fuelUsed == null) return null
  return trip.fuelUsed / trip.distance * 100
}

export function doubtsAbout(trip: ConsumptionTrip): ConsumptionDoubt[] {
  const doubts: ConsumptionDoubt[] = []
  const consumption = consumptionOf(trip)
  const bound = consumptionErrorBound(trip.distance)
  // Расход, не отличимый от нуля, — тоже «слишком коротко»: датчик не сдвинулся
  // ни на ступеньку, и это говорит о поездке ровно столько же, сколько две
  // ступеньки на трёх километрах.
  if (bound != null && (consumption == null || consumption <= 0 || bound > consumption * MAX_ERROR_SHARE)) {
    doubts.push('short')
  }
  const speed = averageSpeed(trip)
  if (speed != null && speed < MIN_DRIVING_SPEED) doubts.push('crawl')
  return doubts
}

// Разбор месяца целиком: сначала отбираются поездки, чей расход вообще измерен,
// по ним считается медиана каждой корзины скорости, и уже от неё меряется
// отклонение остальных.
//
// Выброс объявляется только там, где отклонение больше и собственной ошибки
// поездки, и разброса самой корзины. Первое отсекает округление датчика, второе
// — то, что в «городе» лежат и спальный район, и центр в час пик.
export function assessConsumption(trips: TripConsumption[]): TripConsumptionQuality[] {
  const assessed = trips.map(trip => {
    const speed = averageSpeed(trip)
    return {
      id: trip.id,
      consumption: consumptionOf(trip),
      errorBound: consumptionErrorBound(trip.distance),
      speed,
      bucket: bucketForSpeed(speed)?.name ?? null,
      doubts: doubtsAbout(trip),
      deviation: null as number | null,
      outlier: false
    }
  })

  const buckets = new Map<SpeedBucketName, number[]>()
  for (const item of assessed) {
    if (item.doubts.length || item.bucket == null || item.consumption == null) continue
    const values = buckets.get(item.bucket) ?? []
    values.push(item.consumption)
    buckets.set(item.bucket, values)
  }

  for (const item of assessed) {
    if (item.doubts.length || item.bucket == null || item.consumption == null || item.errorBound == null) continue
    const values = buckets.get(item.bucket)
    if (!values || values.length < MIN_BUCKET_SAMPLES) continue
    const centre = median(values)
    if (centre == null) continue
    item.deviation = item.consumption - centre
    const spread = medianAbsoluteDeviation(values, centre) ?? 0
    item.outlier = Math.abs(item.deviation) > item.errorBound + 2 * spread
  }

  return assessed
}

export const DOUBT_LABELS: Record<ConsumptionDoubt, string> = {
  short: 'Слишком коротко для шага датчика',
  crawl: 'Почти всю поездку стояла'
}
