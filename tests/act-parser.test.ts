import { describe, expect, it } from 'vitest'
import { normalizeOrderNumber, parseActText, parseRussianDate, parseRussianNumberWords } from '../shared/act-parser'

// What Tesseract actually produced from the dealer's order, flattened table and
// all. Keeping the real output means the parser is tested against the noise it
// will meet rather than against a tidy invention.
const RECOGNIZED = `
побус
з обл, Тамбов г, yn Бастионная, дом №29
Заказ-Наряд № 4000014533 от 22 мая 2025 г.
Тип ремонта: Техническое
обслуживание
Пробег, км
P796PA68 CHERY TIGGO 4 PRO
1938
Работы
Материалы
1 |480-1012010 Фильтр масляный 1.5
| а [cHervswao200 Масло моторное Chery SW-40 API SP, АСЕА АЗ/В4, нк 2
Итого работы и материалы
Общая сумма, Р
1 658,01 9 948
Общая сумма прописью: Девять тысяч девятьсот сорок восемь рублей 00 копеек
Рекомендации по заказ-наряду
`

describe('parseRussianNumberWords', () => {
  it.each([
    ['Девять тысяч девятьсот сорок восемь рублей 00 копеек', 9948],
    ['Семнадцать тысяч пятьсот пятьдесят шесть рублей 00 копеек', 17556],
    ['Пятнадцать тысяч четыреста девяносто три рубля 00 копеек', 15493],
    ['Тысяча двести рублей', 1200],
    ['Сто рублей', 100]
  ])('reads %s', (text, expected) => {
    expect(parseRussianNumberWords(text)).toBe(expected)
  })

  it('stops at the roubles so the kopecks never join the sum', () => {
    expect(parseRussianNumberWords('Сто рублей девяносто копеек')).toBe(100)
  })

  it('has no answer when there are no number words at all', () => {
    expect(parseRussianNumberWords('Рекомендации по заказ-наряду')).toBeNull()
    expect(parseRussianNumberWords('')).toBeNull()
  })
})

describe('parseRussianDate', () => {
  const moscow = (value: Date | null) => value && new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(value)

  it('reads the day the document names, and keeps it that day', () => {
    expect(moscow(parseRussianDate('22 мая 2025 г.'))).toBe('2025-05-22')
    expect(moscow(parseRussianDate('29 июля 2026 г.'))).toBe('2026-07-29')
  })

  it('refuses a month it does not know and a year out of range', () => {
    expect(parseRussianDate('22 мартобря 2025 г.')).toBeNull()
    expect(parseRussianDate('22 мая 1825 г.')).toBeNull()
    expect(parseRussianDate('без даты')).toBeNull()
  })
})

describe('normalizeOrderNumber', () => {
  it('folds the Latin lookalikes OCR picks by shape', () => {
    expect(normalizeOrderNumber('TH000027679')).toBe('ТН000027679')
    expect(normalizeOrderNumber('ТН000027679')).toBe('ТН000027679')
  })

  it('reads a leading four as the letter it is, and leaves the rest alone', () => {
    expect(normalizeOrderNumber('4000014533')).toBe('Ч000014533')
    expect(normalizeOrderNumber('Ч000014533')).toBe('Ч000014533')
  })
})

describe('parseActText', () => {
  const parsed = parseActText(RECOGNIZED)

  it('pulls the order number and date out of one line', () => {
    expect(parsed.orderNumber).toBe('Ч000014533')
    expect(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(parsed.performedAt!)).toBe('2025-05-22')
  })

  it('finds the odometer on its own line rather than in the VIN', () => {
    expect(parsed.mileage).toBe(1938)
  })

  it('trusts the sum only because the digits and the words agree', () => {
    expect(parsed.totalFromWords).toBe(9948)
    expect(parsed.totalFromDigits).toBe(9948)
    expect(parsed.totalsAgree).toBe(true)
    expect(parsed.totalAmount).toBe(9948)
  })

  it('recognises the kind of work and that oil was part of it', () => {
    expect(parsed.isServiceAct).toBe(true)
    expect(parsed.mentionsOil).toBe(true)
    expect(parsed.anchors).toBeGreaterThanOrEqual(5)
  })

  it('will not pass off a sum whose two printings disagree', () => {
    const mismatched = parseActText(RECOGNIZED.replace('1 658,01 9 948', '1 658,01 9 048'))
    expect(mismatched.totalsAgree).toBe(false)
  })

  // The VIN ends in six digits that read as a perfectly plausible odometer, and
  // it beat the real reading until the search demanded a line of nothing else.
  it('does not take the tail of the VIN for an odometer', () => {
    const withVin = parseActText(`
Пробег, км
P796PA68 CHERY TIGGO 4 PRO LVVDB21B1RD124488
`)
    expect(withVin.mileage).toBeNull()
  })

  it('says nothing about a page it did not understand', () => {
    const noise = parseActText('вазо.У8 ДИЧУЕ / улноиВа виаодои')
    expect(noise).toMatchObject({ orderNumber: null, performedAt: null, mileage: null, totalAmount: null, anchors: 0 })
  })
})
