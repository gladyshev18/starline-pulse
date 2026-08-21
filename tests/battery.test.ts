import { describe, expect, it } from 'vitest'
import { BATTERY_WARNING_VOLTS, batteryTrend } from '../shared/battery'

// A year of nightly readings: one every day, declining by `perMonth` volts, with
// the seasons pushing the reading up and down by ten millivolts per degree.
function year(perMonth: number, options: { ambient?: boolean, days?: number, noise?: number } = {}) {
  const days = options.days ?? 200
  return Array.from({ length: days }, (_, day) => {
    const ambient = 10 + 15 * Math.sin(day / 58)
    // A deterministic wobble so the fit has something to average out without the
    // test depending on a random seed.
    const noise = (options.noise ?? 0) * Math.sin(day * 2.399)
    return {
      day,
      volts: 12.7 + perMonth * (day / 30.437) + (options.ambient === false ? 0 : 0.01 * (ambient - 10)) + noise,
      ambient: options.ambient === false ? null : ambient
    }
  })
}

describe('batteryTrend', () => {
  it('recovers a real decline through a year of seasons', () => {
    const trend = batteryTrend(year(-0.02))
    expect(trend.ambientAdjusted).toBe(true)
    expect(trend.slopePerMonth!).toBeCloseTo(-0.02, 3)
    expect(trend.confident).toBe(true)
  })

  it('does not mistake the cold for a dying battery', () => {
    // No decline at all, only weather. Without the temperature column the winter
    // dip alone would fit as a downward slope.
    const trend = batteryTrend(year(0))
    expect(Math.abs(trend.slopePerMonth!)).toBeLessThan(0.005)
    expect(trend.daysToWarning).toBeNull()
  })

  it('falls back to time alone when the weather is mostly missing', () => {
    const trend = batteryTrend(year(-0.02, { ambient: false }))
    expect(trend.ambientAdjusted).toBe(false)
    expect(trend.slopePerMonth!).toBeCloseTo(-0.02, 2)
  })

  it('claims nothing from a fortnight', () => {
    const trend = batteryTrend(year(-0.02, { days: 14 }))
    expect(trend.confident).toBe(false)
    expect(trend.daysToWarning).toBeNull()
    expect(trend.spanDays).toBe(13)
  })

  it('keeps quiet when the slope is smaller than its own error', () => {
    const trend = batteryTrend(year(-0.001, { noise: 0.15 }))
    expect(trend.confident).toBe(false)
  })

  it('forecasts the crossing only while the battery is still above it', () => {
    const trend = batteryTrend(year(-0.05))
    expect(trend.confident).toBe(true)
    expect(trend.currentVolts!).toBeGreaterThan(BATTERY_WARNING_VOLTS)
    expect(trend.daysToWarning!).toBeGreaterThan(0)
    // Roughly (current − 12.2) volts at 0.05 a month.
    const expected = (trend.currentVolts! - BATTERY_WARNING_VOLTS) / 0.05 * 30.437
    expect(trend.daysToWarning!).toBeCloseTo(expected, -1)
  })

  it('offers no forecast for a battery that is holding steady or rising', () => {
    expect(batteryTrend(year(0.01)).daysToWarning).toBeNull()
  })

  it('drops a temperature column that never moves instead of going unsolvable', () => {
    // A constant ambient column is the constant term over again: together they
    // have no unique solution, and the fit would come back empty.
    const flatWeather = Array.from({ length: 120 }, (_, day) => ({
      day, volts: 12.7 - 0.02 * (day / 30.437), ambient: 20
    }))
    const trend = batteryTrend(flatWeather)
    expect(trend.ambientAdjusted).toBe(false)
    expect(trend.currentVolts).not.toBeNull()
    expect(trend.slopePerMonth!).toBeCloseTo(-0.02, 3)
  })

  it('survives having almost nothing to work with', () => {
    expect(batteryTrend([])).toMatchObject({ days: 0, slopePerMonth: null, confident: false })
    expect(batteryTrend([{ day: 0, volts: 12.5, ambient: 10 }])).toMatchObject({ days: 1, confident: false })
  })
})
