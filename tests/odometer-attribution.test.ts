import { describe, expect, it } from 'vitest'
import { distributeOdometer } from '../metrics/odometer'

// Показание одометра говорит ровно одно: к моменту метки счётчик дошёл до этого
// значения. Когда именно между ним и предыдущим показанием машина накрутила
// разницу — не говорит. Прежний разбор считал, что километры принадлежат тому,
// в чьё окно попала метка, и на разреженных показаниях это разваливалось.
describe('как километры делятся между поездками', () => {
  const base = Date.parse('2026-08-29T09:00:00.000Z')
  const at = (minute: number) => new Date(base + minute * 60_000)
  const reading = (minute: number, value: number) => ({ value, at: at(minute) })
  const window = (id: number, from: number, to: number) => ({ id, from: at(from), to: at(to) })

  const km = (result: ReturnType<typeof distributeOdometer>, id: number) => result.distances.get(id) ?? 0

  it('отдаёт километры той поездке, внутри которой сняли показание', () => {
    const result = distributeOdometer(
      [reading(0, 100), reading(20, 110)],
      [window(1, 5, 15)]
    )
    expect(km(result, 1)).toBe(10)
    expect(result.unattributed).toBe(0)
  })

  // 29 августа десять километров доехали одним показанием в 13:20 и покрывали
  // сразу три отрезка: хвост одной поездки, всю следующую и ещё одну. Достались
  // они последней, не влезли в её две минуты — и вышло 134 км/ч.
  it('делит одно показание между всеми, кто ехал в этом промежутке', () => {
    const result = distributeOdometer(
      [reading(0, 100), reading(60, 110)],
      [window(1, 0, 20), window(2, 30, 50), window(3, 55, 60)]
    )
    // Двадцать, двадцать и пять минут движения — сорок пять всего.
    expect(km(result, 1)).toBeCloseTo(10 * 20 / 45, 6)
    expect(km(result, 2)).toBeCloseTo(10 * 20 / 45, 6)
    expect(km(result, 3)).toBeCloseTo(10 * 5 / 45, 6)
    expect(km(result, 1) + km(result, 2) + km(result, 3)).toBeCloseTo(10, 6)
  })

  it('не даёт ни километра прогреву на автозапуске', () => {
    // У прогрева окно пустое: ехать на охраняемой машине нельзя.
    const result = distributeOdometer(
      [reading(0, 100), reading(60, 110)],
      [{ id: 1, from: at(10), to: at(10) }, window(2, 20, 40)]
    )
    expect(km(result, 1)).toBe(0)
    expect(km(result, 2)).toBe(10)
  })

  it('делит поровну то, что попало на границу двух поездок', () => {
    // Показание пришло, когда одна поездка кончилась, а другая началась: обе
    // ехали внутри промежутка по пять минут.
    const result = distributeOdometer(
      [reading(0, 100), reading(30, 106)],
      [window(1, 0, 5), window(2, 25, 30)]
    )
    expect(km(result, 1)).toBe(3)
    expect(km(result, 2)).toBe(3)
  })

  it('оставляет километры ничьими, если двигатель в промежутке не работал', () => {
    // Поездка, которую опрос не увидел вовсе. Приписать её соседям нельзя, и
    // расхождение с одометром честно покажет, что запись неполная.
    const result = distributeOdometer(
      [reading(0, 100), reading(30, 115)],
      [window(1, 40, 50)]
    )
    expect(km(result, 1)).toBe(0)
    expect(result.unattributed).toBe(15)
  })

  it('не теряет и не удваивает ни одного километра', () => {
    const readings = [reading(0, 100), reading(15, 104), reading(40, 118), reading(90, 130)]
    const windows = [window(1, 2, 12), window(2, 20, 35), window(3, 45, 80), window(4, 82, 88)]
    const result = distributeOdometer(readings, windows)
    const total = windows.reduce((sum, item) => sum + km(result, item.id), 0)
    expect(total + result.unattributed).toBeCloseTo(30, 6)
  })

  it('игнорирует показание, которое не выросло', () => {
    const result = distributeOdometer(
      [reading(0, 100), reading(10, 100), reading(20, 105)],
      [window(1, 0, 20)]
    )
    expect(km(result, 1)).toBe(5)
  })
})
