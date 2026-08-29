import { describe, expect, it } from 'vitest'
import { guessDriver } from '../shared/driver-guess'

const trip = (driver: string, weekday: number, hour: number) => ({ driver, weekday, hour })

describe('guessDriver', () => {
  it('предпочитает того, кто ездит в этот час этого дня недели', () => {
    const history = [
      trip('Игорь', 2, 9), trip('Игорь', 2, 9), trip('Игорь', 2, 8),
      trip('Аня', 5, 9), trip('Аня', 5, 9), trip('Аня', 5, 9), trip('Аня', 5, 10)
    ]
    expect(guessDriver(history, { weekday: 2, hour: 9 })?.driver).toBe('Игорь')
    expect(guessDriver(history, { weekday: 5, hour: 9 })?.driver).toBe('Аня')
  })

  it('засчитывает соседний час: 8:58 и 9:02 — одна и та же поездка', () => {
    const history = [trip('Игорь', 1, 8), trip('Игорь', 1, 9), trip('Игорь', 1, 10)]
    const guess = guessDriver(history, { weekday: 1, hour: 9 })
    expect(guess?.samples).toBe(3)
    expect(guess?.basis).toBe('weekday-hour')
  })

  it('считает полночь и одиннадцать вечера соседними часами', () => {
    const history = [trip('Игорь', 1, 23), trip('Игорь', 1, 0), trip('Игорь', 1, 1)]
    expect(guessDriver(history, { weekday: 1, hour: 0 })?.samples).toBe(3)
  })

  it('расширяет окно, когда в этот день недели поездок мало', () => {
    const history = [
      trip('Игорь', 1, 9), trip('Игорь', 3, 9), trip('Игорь', 4, 9), trip('Аня', 6, 15)
    ]
    const guess = guessDriver(history, { weekday: 2, hour: 9 })
    expect(guess).toEqual({ driver: 'Игорь', share: 1, samples: 3, basis: 'hour' })
  })

  it('делит по дню недели, когда час ничего не разделяет', () => {
    // Ровно то, что в боевой базе: пятнадцать поездок у каждого, оба ездят
    // днём, но один — по выходным, другая — по будням. Час здесь даёт ничью,
    // день недели — полную определённость.
    const history = [
      ...Array.from({ length: 11 }, () => trip('Игорь', 6, 11)),
      ...Array.from({ length: 4 }, () => trip('Игорь', 0, 12)),
      ...Array.from({ length: 15 }, () => trip('Кристина', 3, 11))
    ]
    expect(guessDriver(history, { weekday: 3, hour: 11 })?.driver).toBe('Кристина')
    expect(guessDriver(history, { weekday: 6, hour: 11 })?.driver).toBe('Игорь')
  })

  it('молчит, когда за руль садятся поровну', () => {
    const history = [
      trip('Игорь', 2, 9), trip('Аня', 2, 9), trip('Игорь', 2, 9), trip('Аня', 2, 9),
      trip('Игорь', 4, 14), trip('Аня', 4, 14)
    ]
    expect(guessDriver(history, { weekday: 2, hour: 9 })).toBeNull()
  })

  it('молчит, пока поездок вообще мало', () => {
    expect(guessDriver([trip('Игорь', 2, 9), trip('Игорь', 2, 9)], { weekday: 2, hour: 9 })).toBeNull()
    expect(guessDriver([], { weekday: 2, hour: 9 })).toBeNull()
  })

  it('не даёт частому водителю перебить того, кто ездит именно в этот час', () => {
    const history = [
      ...Array.from({ length: 20 }, () => trip('Аня', 6, 15)),
      trip('Игорь', 1, 8), trip('Игорь', 1, 8), trip('Игорь', 1, 8)
    ]
    expect(guessDriver(history, { weekday: 1, hour: 8 })?.driver).toBe('Игорь')
  })
})
