import { FUEL_SENSOR_STEP_LITRES } from './fuel'

// Average speed is the only thing in the data that says what kind of driving a
// trip was: `position.s` is always zero, so distance over duration is what is
// left — and it turns out to separate the traffic jam from the motorway cleanly,
// because the engine burns roughly the same per minute either way while the
// kilometres differ several-fold.
export const SPEED_BUCKETS = [
  { name: 'jam', label: 'Пробки', upTo: 25 },
  { name: 'city', label: 'Город', upTo: 45 },
  { name: 'mixed', label: 'Смешанно', upTo: 70 },
  { name: 'highway', label: 'Трасса', upTo: Number.POSITIVE_INFINITY }
] as const

export type SpeedBucketName = typeof SPEED_BUCKETS[number]['name']

export interface ConsumptionTrip {
  distance: number | null
  fuelUsed: number | null
  durationMinutes: number | null
  // Minutes the engine ran with the alarm still armed. An armed car cannot be
  // driven, so this is a warm-up sitting inside the trip rather than time spent
  // covering ground.
  armedMinutes?: number | null
}

export interface SpeedBucket {
  name: SpeedBucketName
  label: string
  upTo: number
  trips: number
  distance: number
  fuelUsed: number
  consumption: number | null
  // Every litre in the sum is a difference of two readings rounded to the
  // sensor's step, and both roundings travel with it. A bucket holding a handful
  // of trips carries an error bar wider than the gap to its neighbour, and
  // without it the bars read as measurements rather than as estimates.
  consumptionUncertainty: number | null
}

// A trip is bracketed by the ignition, so its duration holds the warm-up before
// the car pulled away and whatever idling happened before the key came out.
// Dividing distance by all of it reports a car slower than it drove, and speed
// is the only thing that sorts a trip into a bucket at all. The armed minutes
// are the one stretch the data can prove was not movement.
export function movingMinutes(trip: ConsumptionTrip) {
  if (trip.durationMinutes == null || !Number.isFinite(trip.durationMinutes)) return null
  const armed = trip.armedMinutes != null && Number.isFinite(trip.armedMinutes) && trip.armedMinutes > 0
    ? trip.armedMinutes
    : 0
  return Math.max(0, trip.durationMinutes - armed)
}

export function averageSpeed(trip: ConsumptionTrip) {
  if (trip.distance == null || !(trip.distance > 0)) return null
  const minutes = movingMinutes(trip)
  if (minutes == null || !(minutes > 0)) return null
  return trip.distance / (minutes / 60)
}

// Rounding to a fixed step leaves an error spread evenly across that step, whose
// standard deviation is the step over the square root of twelve. Each trip
// contributes two such readings, and independent errors accumulate as the square
// root of their count rather than as the count.
export function fuelSumUncertainty(trips: number) {
  if (!(trips > 0)) return null
  return FUEL_SENSOR_STEP_LITRES / Math.sqrt(12) * Math.sqrt(2 * trips)
}

export function bucketForSpeed(speed: number | null) {
  if (speed == null || !Number.isFinite(speed) || speed <= 0) return null
  return SPEED_BUCKETS.find(bucket => speed < bucket.upTo) ?? SPEED_BUCKETS.at(-1)!
}

// Consumption is summed before it is divided: one trip burning half a litre over
// two kilometres would otherwise carry the same weight as an hour on the
// motorway, and the sensor's half-litre step makes any single short trip mostly
// rounding anyway.
export function summariseBySpeed(trips: ConsumptionTrip[]): SpeedBucket[] {
  const totals = new Map<SpeedBucketName, { trips: number, distance: number, fuelUsed: number }>()
  for (const trip of trips) {
    const bucket = bucketForSpeed(averageSpeed(trip))
    if (!bucket || trip.distance == null || trip.fuelUsed == null) continue
    const current = totals.get(bucket.name) ?? { trips: 0, distance: 0, fuelUsed: 0 }
    current.trips++
    current.distance += trip.distance
    current.fuelUsed += trip.fuelUsed
    totals.set(bucket.name, current)
  }

  return SPEED_BUCKETS.map(bucket => {
    const value = totals.get(bucket.name) ?? { trips: 0, distance: 0, fuelUsed: 0 }
    const fuelError = fuelSumUncertainty(value.trips)
    return {
      name: bucket.name,
      label: bucket.label,
      upTo: bucket.upTo,
      ...value,
      consumption: value.distance > 0 ? value.fuelUsed / value.distance * 100 : null,
      consumptionUncertainty: value.distance > 0 && fuelError != null ? fuelError / value.distance * 100 : null
    }
  })
}

// What a kilometre costs in fuel alone. The litres come from the tank balance
// rather than from the sum of the trips, so idling and the stretch between the
// last trip of the month and the first of the next are inside it too.
export function costPerKilometre(fuelUsed: number | null, distance: number | null, pricePerLitre: number | null) {
  if (fuelUsed == null || distance == null || pricePerLitre == null) return null
  if (!(distance > 0) || !(pricePerLitre > 0)) return null
  return fuelUsed * pricePerLitre / distance
}
