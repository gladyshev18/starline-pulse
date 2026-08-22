import { FUEL_SENSOR_STEP_LITRES } from './fuel'

export { FUEL_SENSOR_STEP_LITRES }

// What separates a warm-up from simply sitting with the engine on. The coolant
// holds 87-90 °C once the engine is at work and a restart minutes after a trip
// still reads 60-70 °C, so the line is drawn low enough that only a genuinely
// cooled engine falls below it.
export const WARM_ENGINE_CELSIUS = 70

// Stands in until the car has idled enough for its own readings to beat a
// guess: a warm 1.5-2.0 litre petrol engine burns roughly this much at idle.
export const DEFAULT_IDLE_LITRES_PER_HOUR = 0.8

// Outside this band the sample is not an idle rate but a symptom — a refuel
// that landed inside a session, a stuck sensor, or a session that did move.
export const IDLE_RATE_MIN_LITRES_PER_HOUR = 0.3
export const IDLE_RATE_MAX_LITRES_PER_HOUR = 3

// The car's own measurement replaces the default once its error bar shrinks to
// this share of the measured drop.
export const IDLE_RATE_MAX_UNCERTAINTY = 0.35

export interface IdleRateSample {
  durationMinutes: number | null
  fuelStart: number | null
  fuelEnd: number | null
}

export interface IdleRate {
  litresPerHour: number
  // Null whenever the default is in use: a constant has no error bar of its own,
  // and printing one would dress a guess up as a measurement.
  uncertaintyLitresPerHour: number | null
  source: 'measured' | 'default'
  sessions: number
  minutes: number
  litres: number
}

// A session whose drop cannot be idling however the rounding fell: a refuel that
// landed inside it, a stuck sensor, or a session that did move. The test is in
// litres rather than in litres per hour because a rate cap would be a trap — a
// two minute session is at the sensor's mercy, and rejecting it at 3 l/h would
// throw away every short session whose rounding went up while keeping every one
// whose rounding went down, dragging the whole estimate below the truth. Adding
// a full step to the ceiling asks the only fair question: is this drop still too
// large once rounding is given every benefit of the doubt?
function isSymptom(durationMinutes: number, litres: number) {
  return litres > durationMinutes / 60 * IDLE_RATE_MAX_LITRES_PER_HOUR + FUEL_SENSOR_STEP_LITRES
}

// Idling burns far less per minute than the sensor can resolve — a ten minute
// warm-up moves the tank by about a tenth of one step — so no single session
// measures anything. Only the pile of them does, and only because the rounding
// error of each is as likely to fall one way as the other.
export function measureIdleRate(samples: IdleRateSample[]): IdleRate {
  let sessions = 0
  let minutes = 0
  let litres = 0
  for (const sample of samples) {
    if (sample.durationMinutes == null || !(sample.durationMinutes > 0)) continue
    if (sample.fuelStart == null || sample.fuelEnd == null) continue
    // A tank that ends fuller than it started saw the pump, not the engine.
    if (sample.fuelEnd > sample.fuelStart) continue
    const burned = sample.fuelStart - sample.fuelEnd
    if (isSymptom(sample.durationMinutes, burned)) continue
    sessions++
    minutes += sample.durationMinutes
    litres += burned
  }

  const fallback: IdleRate = {
    litresPerHour: DEFAULT_IDLE_LITRES_PER_HOUR,
    uncertaintyLitresPerHour: null,
    source: 'default',
    sessions,
    minutes,
    litres
  }
  if (!sessions || minutes <= 0 || litres <= 0) return fallback

  // Rounding to a fixed step leaves an error spread evenly across that step,
  // whose standard deviation is the step over the square root of twelve. Each
  // session contributes two such readings, and independent errors accumulate as
  // the square root of their count rather than as the count.
  const readingError = FUEL_SENSOR_STEP_LITRES / Math.sqrt(12)
  const litresError = readingError * Math.sqrt(2 * sessions)
  const litresPerHour = litres / minutes * 60
  const withinBand = litresPerHour >= IDLE_RATE_MIN_LITRES_PER_HOUR && litresPerHour <= IDLE_RATE_MAX_LITRES_PER_HOUR
  if (!withinBand || litresError / litres > IDLE_RATE_MAX_UNCERTAINTY) return fallback

  return {
    litresPerHour,
    uncertaintyLitresPerHour: litresError / minutes * 60,
    source: 'measured',
    sessions,
    minutes,
    litres
  }
}

export interface IdleCostInput {
  minutes: number
  rate: IdleRate
  pricePerLitre: number | null
}

export interface IdleCost {
  minutes: number
  litres: number
  litresUncertainty: number | null
  cost: number | null
  costUncertainty: number | null
}

export function idleCost(input: IdleCostInput): IdleCost {
  const minutes = Math.max(0, input.minutes)
  const hours = minutes / 60
  const litres = hours * input.rate.litresPerHour
  const litresUncertainty = input.rate.uncertaintyLitresPerHour == null
    ? null
    : hours * input.rate.uncertaintyLitresPerHour
  const price = input.pricePerLitre != null && Number.isFinite(input.pricePerLitre) && input.pricePerLitre > 0
    ? input.pricePerLitre
    : null
  return {
    minutes,
    litres,
    litresUncertainty,
    cost: price == null ? null : litres * price,
    costUncertainty: price == null || litresUncertainty == null ? null : litresUncertainty * price
  }
}

// Null, not false, when the temperature is missing: an unclassified session
// still burned fuel and still belongs in the total, it just cannot be called a
// warm-up either way.
export function isColdStart(engineTempStart: number | null | undefined) {
  if (engineTempStart == null || !Number.isFinite(engineTempStart)) return null
  return engineTempStart < WARM_ENGINE_CELSIUS
}
