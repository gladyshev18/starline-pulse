// A lead-acid battery loses capacity over years, and the only symptom visible
// from outside is its resting voltage sagging. Two things confound that: the
// alternator, which is why only readings taken hours after the engine stopped
// count, and the cold, which drops resting voltage by roughly ten millivolts a
// degree without anything being wrong. The second one matters most here, since
// a battery watched from autumn to winter would otherwise look like it is dying
// on schedule every year.

// Resting voltage of a healthy, fully charged battery. Below the warning level a
// battery is at about half charge and will start refusing cold mornings.
export const BATTERY_HEALTHY_VOLTS = 12.6
export const BATTERY_WARNING_VOLTS = 12.2

// Nothing is claimed from a sample too short or too flat to mean anything. Two
// months is the shortest span in which a real decline outruns the noise of a
// half-volt-resolution reading taken once a night.
export const BATTERY_MIN_DAYS = 45
export const BATTERY_MIN_SPAN_DAYS = 60

// Being statistically distinguishable from zero is not the same as mattering. A
// clean sample can make a slope of a millionth of a volt "significant", and it
// would still take longer than the car will exist to mean anything, so the slope
// has to clear a physical floor as well: two millivolts a month is a fortieth of
// a volt over a year, which is about where a reading once a night can see it.
export const BATTERY_MIN_SLOPE_VOLTS_PER_MONTH = 0.002

// A crossing further out than this is not a forecast, it is arithmetic.
export const BATTERY_MAX_FORECAST_DAYS = 5 * 365

// Below this the temperature column carries no information the constant term
// does not already carry, and including it makes the system unsolvable.
export const AMBIENT_MIN_SPREAD_CELSIUS = 3

export interface BatteryReading {
  // Days since the first reading; the regression is in days, not dates.
  day: number
  volts: number
  ambient: number | null
}

export interface BatteryTrend {
  days: number
  spanDays: number
  // Volts per month, already adjusted for temperature when there was enough of
  // it to adjust with.
  slopePerMonth: number | null
  standardError: number | null
  ambientAdjusted: boolean
  // Where the fit says the battery sits today, with the weather taken out.
  currentVolts: number | null
  confident: boolean
  daysToWarning: number | null
}

// Gauss-Jordan on the augmented matrix. Small and readable beats clever here:
// the largest system this ever solves is three by three.
function solve(matrix: number[][], vector: number[]) {
  const size = vector.length
  const augmented = matrix.map((row, index) => [...row, vector[index]!])
  const inverse = matrix.map((_, row) => matrix.map((__, column) => (row === column ? 1 : 0)))

  for (let pivot = 0; pivot < size; pivot++) {
    let best = pivot
    for (let row = pivot + 1; row < size; row++) {
      if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[best]![pivot]!)) best = row
    }
    if (Math.abs(augmented[best]![pivot]!) < 1e-12) return null
    ;[augmented[pivot], augmented[best]] = [augmented[best]!, augmented[pivot]!]
    ;[inverse[pivot], inverse[best]] = [inverse[best]!, inverse[pivot]!]

    const divisor = augmented[pivot]![pivot]!
    for (let column = 0; column <= size; column++) augmented[pivot]![column]! /= divisor
    for (let column = 0; column < size; column++) inverse[pivot]![column]! /= divisor

    for (let row = 0; row < size; row++) {
      if (row === pivot) continue
      const factor = augmented[row]![pivot]!
      if (!factor) continue
      for (let column = 0; column <= size; column++) augmented[row]![column]! -= factor * augmented[pivot]![column]!
      for (let column = 0; column < size; column++) inverse[row]![column]! -= factor * inverse[pivot]![column]!
    }
  }
  return { coefficients: augmented.map(row => row[size]!), inverse }
}

// Ordinary least squares. `columns` builds the row of predictors for a reading,
// with the constant term included by the caller.
function fit(readings: BatteryReading[], columns: (reading: BatteryReading) => number[]) {
  const rows = readings.map(columns)
  const width = rows[0]?.length ?? 0
  if (rows.length <= width) return null

  const normal = Array.from({ length: width }, (_, i) => Array.from({ length: width }, (_, j) =>
    rows.reduce((sum, row) => sum + row[i]! * row[j]!, 0)))
  const target = Array.from({ length: width }, (_, i) =>
    rows.reduce((sum, row, index) => sum + row[i]! * readings[index]!.volts, 0))

  const solved = solve(normal, target)
  if (!solved) return null

  const residuals = readings.map((reading, index) =>
    reading.volts - rows[index]!.reduce((sum, value, i) => sum + value * solved.coefficients[i]!, 0))
  const variance = residuals.reduce((sum, value) => sum + value * value, 0) / (rows.length - width)
  return {
    coefficients: solved.coefficients,
    standardErrors: solved.coefficients.map((_, i) => Math.sqrt(Math.max(0, variance * solved.inverse[i]![i]!)))
  }
}

export function batteryTrend(readings: BatteryReading[]): BatteryTrend {
  const sorted = [...readings].filter(item => Number.isFinite(item.volts)).sort((a, b) => a.day - b.day)
  const spanDays = sorted.length ? sorted.at(-1)!.day - sorted[0]!.day : 0
  const empty: BatteryTrend = {
    days: sorted.length,
    spanDays,
    slopePerMonth: null,
    standardError: null,
    ambientAdjusted: false,
    currentVolts: null,
    confident: false,
    daysToWarning: null
  }
  if (sorted.length < 3) return empty

  // Temperature only earns a place in the model when nearly every reading has
  // it; a column that is mostly guesswork would distort the slope it is meant
  // to protect. It also has to actually vary — a constant column is the constant
  // term over again, and the two together have no unique solution at all.
  const withAmbient = sorted.filter(item => item.ambient != null)
  const spread = withAmbient.length
    ? Math.max(...withAmbient.map(item => item.ambient!)) - Math.min(...withAmbient.map(item => item.ambient!))
    : 0
  const useAmbient = withAmbient.length >= sorted.length * 0.8
    && withAmbient.length >= 3
    && spread >= AMBIENT_MIN_SPREAD_CELSIUS
  const sample = useAmbient ? withAmbient : sorted
  // Should the fit still come out singular, time alone is better than nothing.
  const result = (useAmbient ? fit(sample, item => [1, item.day, item.ambient!]) : null)
    ?? fit(sorted, item => [1, item.day])
  if (!result) return empty
  const ambientAdjusted = useAmbient && result.coefficients.length === 3

  const fitted = ambientAdjusted ? sample : sorted
  const slopePerDay = result.coefficients[1]!
  const slopePerMonth = slopePerDay * 30.437
  const standardError = result.standardErrors[1]! * 30.437
  // A slope smaller than twice its own error is a slope the data does not have;
  // one below the floor is a slope nobody needs.
  const meaningful = Math.abs(slopePerMonth) > 2 * standardError
    && Math.abs(slopePerMonth) >= BATTERY_MIN_SLOPE_VOLTS_PER_MONTH
  const confident = meaningful && fitted.length >= BATTERY_MIN_DAYS && spanDays >= BATTERY_MIN_SPAN_DAYS

  const lastDay = fitted.at(-1)!.day
  // Evaluated at a neutral temperature so the answer is the battery, not today's
  // weather; without the ambient term the intercept already carries it.
  const referenceAmbient = ambientAdjusted
    ? fitted.reduce((sum, item) => sum + item.ambient!, 0) / fitted.length
    : 0
  const currentVolts = ambientAdjusted
    ? result.coefficients[0]! + slopePerDay * lastDay + result.coefficients[2]! * referenceAmbient
    : result.coefficients[0]! + slopePerDay * lastDay

  const crossing = confident && slopePerDay < 0 && currentVolts > BATTERY_WARNING_VOLTS
    ? (currentVolts - BATTERY_WARNING_VOLTS) / -slopePerDay
    : null
  const daysToWarning = crossing != null && crossing <= BATTERY_MAX_FORECAST_DAYS ? crossing : null

  return {
    days: fitted.length,
    spanDays,
    slopePerMonth,
    standardError,
    ambientAdjusted,
    currentVolts,
    confident,
    daysToWarning
  }
}
