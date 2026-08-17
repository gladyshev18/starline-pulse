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

export function fuelToFull(currentFuel: number | null | undefined) {
  if (currentFuel == null || !Number.isFinite(currentFuel)) return null
  return Math.max(0, FUEL_TANK_CAPACITY_LITRES - Math.max(0, currentFuel))
}
