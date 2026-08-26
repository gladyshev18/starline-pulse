export const FUEL_TANK_CAPACITY_LITRES = 51

// The OBD percentage is the finest fuel reading the car gives us: `fuel_litres`
// never arrives, and `fuel_converted` is this very percentage floored to whole
// litres against a fifty litre tank — across the whole history it is always
// `floor(percent / 2)`, never the tank this car actually carries. So that field
// is both coarse and low: the floor doubles the step to a whole litre and the
// wrong tank shaves another two percent, and both show up twice over in
// consumption and refuel volumes since those are differences. Converting the
// percentage here keeps the sensor's own resolution of one percent.
export function fuelFromPercent(percent: number | null | undefined) {
  if (percent == null || !Number.isFinite(percent)) return null
  return Math.min(100, Math.max(0, percent)) * FUEL_TANK_CAPACITY_LITRES / 100
}

// One percent of the tank is the smallest fuel change the car can report, so
// every reading is rounded to this step and a difference of two readings drags
// the rounding of both along with it.
export const FUEL_SENSOR_STEP_LITRES = FUEL_TANK_CAPACITY_LITRES / 100

// What a trip burned, as the tank saw it — and it is allowed to come out
// negative. Both readings are rounded to the sensor's step, so a trip that
// burned less than that step is as likely to measure slightly below zero as
// slightly above it. Discarding only the negative half would cull exactly the
// samples whose noise fell one way, and every average built on the survivors —
// the speed buckets, the per-driver split — would read high. Kept signed, the
// errors cancel in the sum instead.
//
// A rise larger than one step is not rounding but a refuel that landed inside
// the trip, and how much of the tank went through the engine before it is
// genuinely unknowable.
export function tripFuelUsed(fuelStart: number | null | undefined, fuelEnd: number | null | undefined) {
  if (fuelStart == null || fuelEnd == null) return null
  if (!Number.isFinite(fuelStart) || !Number.isFinite(fuelEnd)) return null
  const used = fuelStart - fuelEnd
  return used >= -FUEL_SENSOR_STEP_LITRES ? used : null
}

export interface FuelBalanceInput {
  tankStart: number | null
  tankEnd: number | null
  refuelled: number
  // Refuels whose volume is unknown: the balance would silently blame their
  // litres on the engine.
  refuelsWithoutVolume: number
  tripsFuelUsed: number
}

// Summing what the trips recorded loses fuel in one direction only. The sensor
// moves in 1% steps, so a trip burning less than half a litre records zero; a
// trip spanning a refuel records nothing at all; and idling never becomes a trip
// in the first place. Against the tank itself none of that escapes — whatever
// was poured in and is no longer there went through the engine.
export function fuelBalance(input: FuelBalanceInput) {
  const { tankStart, tankEnd, refuelled, refuelsWithoutVolume, tripsFuelUsed } = input
  // A refuel of unknown size would land in the total as consumption, which is
  // worse than undercounting, so the trips stay the answer until it is known.
  if (tankStart == null || tankEnd == null || refuelsWithoutVolume > 0) {
    return { fuelUsed: tripsFuelUsed, source: 'trips' as const, tankStart, tankEnd, refuelled }
  }
  return {
    fuelUsed: Math.max(0, tankStart + refuelled - tankEnd),
    source: 'balance' as const,
    tankStart,
    tankEnd,
    refuelled
  }
}

export function fuelToFull(currentFuel: number | null | undefined) {
  if (currentFuel == null || !Number.isFinite(currentFuel)) return null
  return Math.max(0, FUEL_TANK_CAPACITY_LITRES - Math.max(0, currentFuel))
}
