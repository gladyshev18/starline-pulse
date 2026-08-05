export const FUEL_TANK_CAPACITY_LITRES = 50

export function fuelToFull(currentFuel: number | null | undefined) {
  if (currentFuel == null || !Number.isFinite(currentFuel)) return null
  return Math.max(0, FUEL_TANK_CAPACITY_LITRES - Math.max(0, currentFuel))
}
