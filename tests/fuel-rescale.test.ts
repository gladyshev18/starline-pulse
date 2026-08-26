import { describe, expect, it } from 'vitest'
import { rescaleLitres } from '../scripts/rescale-fuel-to-tank'

// Границы поездок хранят только литры, поэтому процент, из которого они выросли,
// ищется по снимку, откуда значение и было скопировано.
describe('rescaleLitres', () => {
  it('takes the percentage from the snapshot whose litres the boundary repeats', () => {
    const readings = [{ percent: 76, fuel: 38 }, { percent: 77, fuel: 38.5 }, { percent: 78, fuel: 39 }]
    expect(rescaleLitres(38.5, readings, 51)).toBeCloseTo(39.27)
    expect(rescaleLitres(39, readings, 51)).toBeCloseTo(39.78)
  })

  it('falls back to a floored figure when nothing matches exactly', () => {
    // Снимок пересчитан, а граница осталась той, что писала прошивка: целые
    // литры, округлённые вниз. Здесь их объясняет ровно одно показание.
    expect(rescaleLitres(38, [{ percent: 77, fuel: 38.5 }], 51)).toBeCloseTo(39.27)
  })

  it('refuses to guess while two readings floor to the same litre', () => {
    // 31.11 и 31.62 — это 61% и 62%, и вниз оба дают 31.
    expect(rescaleLitres(31, [{ percent: 61, fuel: 31.11 }, { percent: 62, fuel: 31.62 }], 51)).toBeNull()
  })

  it('prefers an exact match over a floored one', () => {
    // 31.0 записано ровно с одного снимка, хотя вниз до 31 округляется и соседний.
    const readings = [{ percent: 62, fuel: 31 }, { percent: 63, fuel: 31.5 }]
    expect(rescaleLitres(31, readings, 51)).toBeCloseTo(31.62)
  })

  it('gives up when the window holds nothing that explains the value', () => {
    expect(rescaleLitres(12.5, [{ percent: 77, fuel: 38.5 }], 51)).toBeNull()
    expect(rescaleLitres(null, [{ percent: 77, fuel: 38.5 }], 51)).toBeNull()
  })

  it('leaves the figure where it is once the snapshots already agree', () => {
    // Повторный запуск ничего не двигает: снимок уже пересчитан по новому баку.
    expect(rescaleLitres(39.27, [{ percent: 77, fuel: 39.27 }], 51)).toBeCloseTo(39.27)
  })
})
