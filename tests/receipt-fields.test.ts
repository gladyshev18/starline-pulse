import { describe, expect, it } from 'vitest'
import { completeReceiptAmounts, missingReceiptField, normalizeReceiptFields } from '../receipts/fields'

describe('normalizeReceiptFields', () => {
  it('accepts a comma as the decimal separator', () => {
    expect(normalizeReceiptFields({ litres: '38,42', pricePerLitre: '62,90' }))
      .toMatchObject({ litres: 38.42, pricePerLitre: 62.9 })
  })

  it('defaults the payment method to unknown', () => {
    expect(normalizeReceiptFields({}).paymentMethod).toBe('unknown')
  })

  it('demands a name for an unlisted station', () => {
    expect(() => normalizeReceiptFields({ station: 'other' })).toThrow('Укажите название АЗС')
  })

  it('rejects an unknown station', () => {
    expect(() => normalizeReceiptFields({ station: 'shell' })).toThrow('Выберите АЗС')
  })

  it('rejects a volume that no tank could hold', () => {
    expect(() => normalizeReceiptFields({ litres: 900 })).toThrow('«Объём»')
  })

  it('rejects a date outside a sane range', () => {
    expect(() => normalizeReceiptFields({ purchasedAt: '1899-01-01' })).toThrow('«Дата и время»')
  })

  it('keeps empty strings out of the stored values', () => {
    expect(normalizeReceiptFields({ stationName: '   ', fuelType: '' }))
      .toMatchObject({ stationName: null, fuelType: null })
  })
})

describe('completeReceiptAmounts', () => {
  it('derives the total from litres and price', () => {
    expect(completeReceiptAmounts({ litres: 40, pricePerLitre: 62.5, totalAmount: null }).totalAmount).toBe(2500)
  })

  it('derives litres from the total and price', () => {
    expect(completeReceiptAmounts({ litres: null, pricePerLitre: 62.5, totalAmount: 2500 }).litres).toBe(40)
  })

  it('derives the price from the total and litres', () => {
    expect(completeReceiptAmounts({ litres: 40, pricePerLitre: null, totalAmount: 2500 }).pricePerLitre).toBe(62.5)
  })

  it('gives the price for a receipt that printed only the total, using the sensor volume', () => {
    expect(completeReceiptAmounts({ litres: 20, pricePerLitre: null, totalAmount: 1285 }))
      .toEqual({ litres: 20, pricePerLitre: 64.25, totalAmount: 1285 })
  })

  it('leaves a single known value alone', () => {
    expect(completeReceiptAmounts({ litres: null, pricePerLitre: null, totalAmount: 2500 }))
      .toEqual({ litres: null, pricePerLitre: null, totalAmount: 2500 })
  })
})

describe('missingReceiptField', () => {
  it('asks for the volume first', () => {
    expect(missingReceiptField({ litres: null, pricePerLitre: null, totalAmount: 2500 })).toBe('litres')
  })

  it('asks for the total once the volume is known', () => {
    expect(missingReceiptField({ litres: 40, pricePerLitre: null, totalAmount: null })).toBe('totalAmount')
  })

  it('asks nothing when both are known', () => {
    expect(missingReceiptField({ litres: 40, pricePerLitre: null, totalAmount: 2500 })).toBeNull()
  })
})
