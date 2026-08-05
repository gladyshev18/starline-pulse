type TripMetricSource = {
  startedAt: Date | string | number
  endedAt: Date | string | number | null
  mileageStart: number | null
  mileageEnd: number | null
  distance: number | null
  fuelStart: number | null
  fuelEnd: number | null
  fuelUsed: number | null
}

function nonNegative(value: number | null) {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null
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
  const fuelDifference = trip.fuelStart != null && trip.fuelEnd != null && trip.fuelEnd <= trip.fuelStart
    ? trip.fuelStart - trip.fuelEnd
    : null
  const startedAt = timestamp(trip.startedAt)
  const endedAt = timestamp(trip.endedAt)
  const distance = nonNegative(trip.distance) ?? nonNegative(mileageDistance)
  const fuelUsed = nonNegative(trip.fuelUsed) ?? nonNegative(fuelDifference)
  const durationMinutes = startedAt != null && endedAt != null && endedAt >= startedAt
    ? (endedAt - startedAt) / 60_000
    : null

  return {
    distance,
    durationMinutes,
    fuelUsed,
    consumption: distance != null && distance > 0 && fuelUsed != null ? fuelUsed / distance * 100 : null
  }
}
