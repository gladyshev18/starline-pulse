import { describe, expect, it } from 'vitest'
import { ambientFromEngine, assembleAmbientDays, nightAmbientFromEngine, type AmbientHour } from '../shared/ambient'

const DAY_MS = 24 * 60 * 60_000

// Суточный ход, снятый с боевых данных за сентябрь: ночью на шесть градусов
// холоднее средней, к пяти вечера на одиннадцать теплее. Размах в семнадцать
// градусов — это и есть та величина, из-за которой день в разъездах нельзя
// усреднять как есть.
const SHAPE = [-2.2, -3, -3.8, -4.7, -5.4, -6, -6.4, -6.1, -5.2, -2.7, 0.2, 4.2, 5.3, 6.9, 7.9, 9, 10.3, 11.2, 8.1, 5.8, 4.1, 2.6, 0.7, -1]

function dayName(index: number) {
  return new Date(Date.parse('2026-09-30T12:00:00+03:00') - index * DAY_MS).toISOString().slice(0, 10)
}

// Ряд суток одинаковой погоды: `means` — показания датчика, усреднённые за
// сутки, на них накладывается суточный ход. `hours` задаёт, какие часы машина
// провела остывшей; по умолчанию — все.
function hours(means: number[], keep: (hour: number, index: number) => boolean = () => true): AmbientHour[] {
  const rows: AmbientHour[] = []
  means.forEach((mean, index) => {
    const day = dayName(means.length - 1 - index)
    for (let hour = 0; hour < 24; hour++) {
      if (keep(hour, index)) rows.push({ day, hour, engine: mean + SHAPE[hour]! })
    }
  })
  return rows
}

describe('собранные сутки', () => {
  it('считают среднюю по часам, а ночь — по самым холодным из них', () => {
    const days = assembleAmbientDays(hours([20]))
    expect(days).toHaveLength(1)
    expect(days[0]!.mean).toBeCloseTo(ambientFromEngine(20 + SHAPE.reduce((a, b) => a + b, 0) / 24), 5)
    expect(days[0]!.night).toBeCloseTo(nightAmbientFromEngine(20 + Math.min(...SHAPE.slice(2, 8))), 5)
    expect(days[0]!.hours).toBe(24)
    expect(days[0]!.estimated).toBe(false)
  })

  it('не считают сутки, у которых нет ни одного ночного часа', () => {
    // Вечер без ночи: «минимум за сутки» был бы самым холодным из вечерних
    // часов и о заморозках не сказал бы ничего.
    expect(assembleAmbientDays(hours([20], hour => hour >= 18))).toHaveLength(0)
  })

  it('не считают сутки, от которых остались три часа', () => {
    expect(assembleAmbientDays(hours([20], hour => hour < 3))).toHaveLength(0)
  })

  it('восстанавливают день, проведённый в разъездах, вместо того чтобы его выбросить', () => {
    // Двадцать суток ровной погоды, у последних машина уезжает в полдень и
    // возвращается к ночи. Без поправки такие сутки вышли бы на пять градусов
    // холоднее — в них остались одни утренние часы.
    const means = Array.from({ length: 20 }, () => 20)
    const rows = hours(means, (hour, index) => index < 19 || hour < 12)
    const days = assembleAmbientDays(rows)
    expect(days).toHaveLength(20)

    const last = days.at(-1)!
    const full = days[0]!
    expect(last.estimated).toBe(true)
    expect(full.estimated).toBe(false)
    expect(last.hours).toBe(12)
    expect(last.mean).toBeCloseTo(full.mean, 5)
  })

  it('идут за погодой, а не за профилем: восстановленный день холоднее, когда холоднее утро', () => {
    const means = [...Array.from({ length: 19 }, () => 20), 12]
    const days = assembleAmbientDays(hours(means, (hour, index) => index < 19 || hour < 12))
    const last = days.at(-1)!
    expect(last.estimated).toBe(true)
    expect(last.mean).toBeCloseTo(ambientFromEngine(12 + SHAPE.reduce((a, b) => a + b, 0) / 24), 1)
  })

  it('не восстанавливают, когда профиль не по чему построить', () => {
    // Четверо суток, и все неполные: усреднять отклонения не с чего, а выдать
    // ночную среднюю за суточную — хуже, чем не выдать ничего.
    const days = assembleAmbientDays(hours([20, 20, 20, 20], hour => hour < 12))
    expect(days).toHaveLength(0)
  })

  it('берут профиль у соседних суток, а не у всей истории', () => {
    // Сентябрь с размахом в семнадцать градусов и декабрь, где его почти нет.
    // Декабрьский день в разъездах должен восстанавливаться по декабрю.
    const rows: AmbientHour[] = []
    for (let index = 0; index < 12; index++) {
      const day = new Date(Date.parse('2026-09-15T12:00:00+03:00') + index * DAY_MS).toISOString().slice(0, 10)
      for (let hour = 0; hour < 24; hour++) rows.push({ day, hour, engine: 20 + SHAPE[hour]! })
    }
    for (let index = 0; index < 12; index++) {
      const day = new Date(Date.parse('2026-12-01T12:00:00+03:00') + index * DAY_MS).toISOString().slice(0, 10)
      // Зимой суточный ход втрое мельче.
      for (let hour = 0; hour < 24; hour++) rows.push({ day, hour, engine: -5 + SHAPE[hour]! / 3 })
    }
    const cut = new Date(Date.parse('2026-12-13T12:00:00+03:00')).toISOString().slice(0, 10)
    for (let hour = 0; hour < 12; hour++) rows.push({ day: cut, hour, engine: -5 + SHAPE[hour]! / 3 })

    const days = assembleAmbientDays(rows)
    const restored = days.find(item => item.day === cut)!
    expect(restored.estimated).toBe(true)
    // Если бы профиль брался по сентябрю, поправка была бы втрое больше и
    // декабрьские сутки уехали бы градуса на четыре вверх.
    expect(restored.mean).toBeCloseTo(-5 + SHAPE.reduce((a, b) => a + b, 0) / 24 / 3, 1)
  })
})
