import { describe, expect, it } from 'vitest'
import { normaliseFuelType } from '../shared/fuel-grades'

describe('normaliseFuelType', () => {
  it('strips the class and the pump wording off an ordinary grade', () => {
    expect(normaliseFuelType('АИ-95-К5')).toBe('АИ-95')
    expect(normaliseFuelType('1. АИ-92-К5')).toBe('АИ-92')
    expect(normaliseFuelType('аи 95')).toBe('АИ-95')
  })

  it('keeps the dearer grade apart whatever the chain calls it', () => {
    expect(normaliseFuelType('АИ-95-К5 Pulsar-95')).toBe('АИ-95 Премиум')
    expect(normaliseFuelType('Бензин автомобильный ЭКТО Plus (АИ-95-К5)')).toBe('АИ-95 Премиум')
    expect(normaliseFuelType('ЭКТО-95')).toBe('АИ-95 Премиум')
    expect(normaliseFuelType('АИ-95 G-Drive')).toBe('АИ-95 Премиум')
    expect(normaliseFuelType('95 премиум')).toBe('АИ-95 Премиум')
  })

  it('leaves ordinary petrol ordinary: at Lukoil that is «Евро», and the class is on every grade', () => {
    expect(normaliseFuelType('ЕВРО-95')).toBe('АИ-95')
    expect(normaliseFuelType('АИ-92-К5 Евро')).toBe('АИ-92')
  })

  it('leaves the hundredth alone: ordinary АИ-100 does not exist', () => {
    expect(normaliseFuelType('АИ-100 Pulsar-100')).toBe('АИ-100')
    expect(normaliseFuelType('АИ-100')).toBe('АИ-100')
  })

  it('keeps what it cannot read as a grade', () => {
    expect(normaliseFuelType('ДТ Евро')).toBe('ДТ Евро')
    expect(normaliseFuelType('   ')).toBeNull()
    expect(normaliseFuelType(null)).toBeNull()
  })
})
