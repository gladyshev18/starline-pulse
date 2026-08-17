export const FUEL_TANK_CAPACITY_LITRES = 50

// The OBD percentage is the finest fuel reading the car gives us: `fuel_litres`
// never arrives, and `fuel_converted` is this very percentage floored to whole
// litres against the same 50 litre tank. That floor doubles the step to 1 litre
// and shaves a quarter litre off every reading, which shows up twice over in
// consumption and refuel volumes since both are differences. Converting here
// keeps the sensor's own half-litre resolution.
export function fuelFromPercent(percent: number | null | undefined) {
  if (percent == null || !Number.isFinite(percent)) return null
  return Math.min(100, Math.max(0, percent)) * FUEL_TANK_CAPACITY_LITRES / 100
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
