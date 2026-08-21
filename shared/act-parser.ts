// A dealer service order is printed to one template, and OCR reads its labels
// far more reliably than its digits: letters have context, a lone "8" does not.
// So every number here is pulled by the words around it, and the total — the one
// figure the document itself prints twice, in digits and in words — is trusted
// only when the two agree.

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
]

const UNITS: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4,
  пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
  пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500,
  шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900
}

function scaleOf(word: string) {
  if (/^тысяч/.test(word)) return 1000
  if (/^миллион/.test(word)) return 1_000_000
  return null
}

// The sum in words is the only figure on the page that OCR cannot quietly get
// wrong by one digit: a misread letter makes a word that is not a number at all,
// which fails loudly instead of turning 9 948 into 9 048.
export function parseRussianNumberWords(text: string) {
  const words = text.toLowerCase().replace(/[^а-яё\s]/g, ' ').split(/\s+/).filter(Boolean)
  let total = 0
  let group = 0
  let seen = false
  for (const word of words) {
    if (/^рубл/.test(word)) break
    const scale = scaleOf(word)
    if (scale) {
      // "тысяч" on its own means one thousand, as in «тысяча двести».
      total += (group || 1) * scale
      group = 0
      seen = true
      continue
    }
    const value = UNITS[word]
    if (value == null) continue
    group += value
    seen = true
  }
  if (!seen) return null
  return total + group
}

function normalizeDigits(value: string) {
  const cleaned = value.replace(/[^\d,.]/g, '').replace(',', '.')
  const result = Number(cleaned)
  return Number.isFinite(result) ? result : null
}

export function parseRussianDate(text: string) {
  const match = /(\d{1,2})\s+([А-Яа-яё]+)\s+(\d{4})/.exec(text)
  if (!match) return null
  const month = MONTHS.indexOf(match[2]!.toLowerCase())
  if (month < 0) return null
  const day = Number(match[1])
  const year = Number(match[3])
  if (day < 1 || day > 31 || year < 2000 || year > 2100) return null
  // The document states a calendar day, and midday Moscow is what keeps it that
  // same day however the reader's clock is set: midnight would slip to the day
  // before for anyone displaying it in UTC.
  return new Date(Date.UTC(year, month, day, 12) - 3 * 60 * 60_000)
}

// OCR picks between Cyrillic and Latin by shape, so the same order number comes
// back as ТН000027679 or TH000027679 from one page to the next, and the Ч of the
// other prefix reads as a 4. Folding the lookalikes together is what makes two
// spellings of one number count as agreement instead of a dispute.
const LOOKALIKES: Record<string, string> = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У'
}

export function normalizeOrderNumber(value: string) {
  const upper = value.toUpperCase()
  const folded = [...upper].map(char => LOOKALIKES[char] ?? char).join('')
  // Only a leading digit four is the letter Ч; inside the number a four is a four.
  return folded.replace(/^4/, 'Ч')
}

export interface ParsedAct {
  orderNumber: string | null
  performedAt: Date | null
  mileage: number | null
  totalAmount: number | null
  totalFromWords: number | null
  totalFromDigits: number | null
  isServiceAct: boolean
  // Whether the parts list names engine oil, which is what decides if this act
  // resets the oil clock or is a repair that leaves it alone.
  mentionsOil: boolean
  anchors: number
  // True only when the printed digits and the printed words agree. Everything
  // downstream that writes to the car's history requires it.
  totalsAgree: boolean
}

const ANCHOR_PATTERNS = [
  /Заказ[\s-]*Наряд/i,
  /Тип\s+ремонта/i,
  /Пробег/i,
  /Общая\s+сумма/i,
  /Материалы/i,
  /Итого/i
]

// The odometer sits in a table cell under its own label, and OCR flattens the
// table into lines: the value lands a line or two below "Пробег, км" with only
// the plate and model in between. Searching forward from the label instead of
// matching a fixed line is what survives that.
function findMileage(lines: string[]) {
  const labelIndex = lines.findIndex(line => /Пробег/i.test(line))
  if (labelIndex < 0) return null
  for (const raw of lines.slice(labelIndex, labelIndex + 5)) {
    const line = raw
      // The VIN sits in the same table row and ends in six digits, which read as
      // a perfectly plausible odometer — it outvoted the real one until it was
      // stripped along with the order number and any other long code.
      .replace(/[A-ZА-Я0-9]{9,}/gi, ' ')
      .replace(/Пробег\s*,?\s*км/i, ' ')
    // The reading has its own cell, so OCR puts it on a line of its own. Anything
    // sharing a line with words is part of the address, the model or the VIN —
    // and the VIN's last six digits pass for an odometer perfectly, which is how
    // 124488 outvoted 1938 until this became a whole-line test.
    // Either the grouped form the paper prints, «18 082», or the run of digits
    // OCR gives back when it loses the thin space between the groups.
    const match = /^\s*(\d{1,3}(?:[\s ]\d{3})+|\d{3,7})\s*$/.exec(line)
    if (!match) continue
    const value = Number(match[1]!.replace(/[\s ]/g, ''))
    // Below a hundred it is a row number or a quantity; above a million it is
    // not this car's odometer.
    if (!Number.isFinite(value) || value < 100 || value > 1_000_000) continue
    // The order date shares this part of the form, and a bare year reads as a
    // four-digit odometer. The cost is a genuine reading between 2015 and 2035
    // km, which this car passed years ago.
    if (value >= 2015 && value <= 2035) continue
    return value
  }
  return null
}

function findTotalDigits(lines: string[]) {
  const index = lines.findIndex(line => /Общая\s+сумма\s*,?\s*[РP₽]?\s*$/i.test(line) || /Общая\s+сумма\s*,\s*[РP₽]/i.test(line))
  if (index < 0) return null
  for (const line of lines.slice(index, index + 4)) {
    const numbers = [...line.matchAll(/\d[\d\s ]*(?:[.,]\d{2})?/g)]
      .map(match => normalizeDigits(match[0]))
      .filter((value): value is number => value != null && value >= 100)
    // The VAT sits on the same flattened line just before the total, so the
    // rightmost figure is the one being looked for.
    if (numbers.length) return numbers.at(-1)!
  }
  return null
}

export function parseActText(text: string): ParsedAct {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const joined = lines.join('\n')
  const anchors = ANCHOR_PATTERNS.filter(pattern => pattern.test(joined)).length

  const orderLine = lines.find(line => /Заказ[\s-]*Наряд/i.test(line)) || ''
  const orderMatch = /Заказ[\s-]*Наряд\s*(?:№|N|Ne)?\s*([A-ZА-Я0-9]{6,})/i.exec(orderLine)
  const performedAt = parseRussianDate(orderLine.replace(/^.*?\bот\b/i, ''))

  const wordsLine = lines.find(line => /прописью/i.test(line)) || ''
  const totalFromWords = /прописью/i.test(wordsLine)
    ? parseRussianNumberWords(wordsLine.replace(/^.*прописью\s*:?/i, ''))
    : null
  const totalFromDigits = findTotalDigits(lines)
  const totalsAgree = totalFromWords != null && totalFromDigits != null
    && Math.abs(totalFromWords - totalFromDigits) < 1

  return {
    orderNumber: orderMatch?.[1] ? normalizeOrderNumber(orderMatch[1]) : null,
    performedAt,
    mileage: findMileage(lines),
    // Words win: a misread letter breaks the word outright, while a misread
    // digit passes for a different number.
    totalAmount: totalFromWords ?? totalFromDigits,
    totalFromWords,
    totalFromDigits,
    isServiceAct: /Техническое\s+обслуживание/i.test(joined),
    mentionsOil: /масл[оа]\s+моторное|моторное\s+масл|5W-?\d0|Фильтр\s+масл/i.test(joined),
    anchors,
    totalsAgree
  }
}
