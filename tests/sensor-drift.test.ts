import { describe, expect, it } from 'vitest'
import { measureSensorDrift } from '../shared/sensor-drift'

describe('measureSensorDrift', () => {
  it('measures how far the gauge sits from the receipt', () => {
    const drift = measureSensorDrift([
      { sensorLitres: 30.5, receiptLitres: 30, percentAfter: 93 },
      { sensorLitres: 25.5, receiptLitres: 25, percentAfter: 88 },
      { sensorLitres: 20.5, receiptLitres: 20, percentAfter: 76 }
    ])
    expect(drift.samples).toBe(3)
    expect(drift.bias).toBeCloseTo(0.5)
  })

  it('drops a refuel that filled the tank, where the gauge hits its ceiling', () => {
    const drift = measureSensorDrift([
      { sensorLitres: 30.5, receiptLitres: 30, percentAfter: 93 },
      { sensorLitres: 20.5, receiptLitres: 20, percentAfter: 100 }
    ])
    expect(drift.samples).toBe(1)
    expect(drift.saturated).toBe(1)
  })

  it('will not call a single half-litre gap systematic', () => {
    // One refuel: the offset is exactly one sensor step, which the rounding of
    // its own two readings can produce on its own.
    const single = measureSensorDrift([{ sensorLitres: 30.5, receiptLitres: 30, percentAfter: 93 }])
    expect(single.bias).toBeCloseTo(0.5)
    expect(single.systematic).toBe(false)
  })

  it('calls it systematic once enough refuels agree', () => {
    const many = measureSensorDrift(Array.from({ length: 8 }, () => ({
      sensorLitres: 30.5, receiptLitres: 30, percentAfter: 90
    })))
    expect(many.systematic).toBe(true)
    expect(many.uncertainty!).toBeLessThan(0.25)
  })

  it('sees no offset where there is none', () => {
    const clean = measureSensorDrift(Array.from({ length: 8 }, () => ({
      sensorLitres: 30, receiptLitres: 30, percentAfter: 90
    })))
    expect(clean.bias).toBe(0)
    expect(clean.systematic).toBe(false)
  })

  it('has nothing to say without both numbers', () => {
    expect(measureSensorDrift([
      { sensorLitres: null, receiptLitres: 30, percentAfter: 90 },
      { sensorLitres: 30, receiptLitres: null, percentAfter: 90 }
    ])).toMatchObject({ samples: 0, bias: null, systematic: false })
  })
})
