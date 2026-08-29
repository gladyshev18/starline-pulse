import { averageSpeed, movingMinutes } from './consumption'
import { tripFuelUsed } from './fuel'

type TripMetricSource = {
  startedAt: Date | string | number
  endedAt: Date | string | number | null
  mileageStart: number | null
  mileageEnd: number | null
  distance: number | null
  fuelStart: number | null
  fuelEnd: number | null
  fuelUsed: number | null
  armedMinutes?: number | null
  departedAt?: Date | string | number | null
}

function nonNegative(value: number | null) {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null
}

// Fuel may legitimately be negative — see `tripFuelUsed` — so only the stored
// value being absent or broken sends this back to the raw readings.
function measured(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value : null
}

function timestamp(value: Date | string | number | null) {
  if (value == null) return null
  const result = new Date(value).getTime()
  return Number.isFinite(result) ? result : null
}

export function calculateTripMetrics(trip: TripMetricSource) {
  const mileageDistance = trip.mileageStart != null && trip.mileageEnd != null && trip.mileageEnd >= trip.mileageStart
    ? trip.mileageEnd - trip.mileageStart
    : null
  const startedAt = timestamp(trip.startedAt)
  const endedAt = timestamp(trip.endedAt)
  const distance = nonNegative(trip.distance) ?? nonNegative(mileageDistance)
  const fuelUsed = measured(trip.fuelUsed) ?? tripFuelUsed(trip.fuelStart, trip.fuelEnd)
  const durationMinutes = startedAt != null && endedAt != null && endedAt >= startedAt
    ? (endedAt - startedAt) / 60_000
    : null
  // Сколько машина стояла с работающим двигателем, прежде чем тронуться:
  // от включения зажигания до того, как опустили ручник.
  const departedAt = timestamp(trip.departedAt ?? null)
  const preDepartureMinutes = startedAt != null && departedAt != null && departedAt >= startedAt
    ? (departedAt - startedAt) / 60_000
    : null
  const shape = {
    distance,
    fuelUsed,
    durationMinutes,
    armedMinutes: trip.armedMinutes ?? null,
    preDepartureMinutes
  }

  return {
    distance,
    durationMinutes,
    preDepartureMinutes,
    // What is left of the duration once the warm-up on the alarm is taken out:
    // the time the speed is measured over, and the reason it can differ from the
    // length of the trip the driver remembers.
    movingMinutes: movingMinutes(shape),
    fuelUsed,
    consumption: distance != null && distance > 0 && fuelUsed != null ? fuelUsed / distance * 100 : null,
    averageSpeed: averageSpeed(shape)
  }
}
