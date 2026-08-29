// Кого предложить первым, когда бот спрашивает про только что законченную
// поездку. За рулём отмечается треть поездок, и причина простая: выбрать имя
// из четырёх кнопок — работа, а поездки повторяются. Если по вторникам в девять
// утра последние десять раз ехал один и тот же человек, одиннадцатый вопрос
// можно задать так, чтобы ответом было одно нажатие.
//
// Догадка ничего не записывает сама: подставить водителя молча значило бы
// выдумать данные, а разбивка по водителям потом читается как измеренная.

export interface DriverHistoryEntry {
  driver: string
  weekday: number
  hour: number
}

export interface DriverMoment {
  weekday: number
  hour: number
}

export interface DriverGuess {
  driver: string
  // Доля поездок этого водителя в окне, по которому сделана догадка.
  share: number
  samples: number
  basis: 'weekday-hour' | 'weekday' | 'hour' | 'overall'
}

// Соседний час засчитывается тоже: выезд в 8:58 и выезд в 9:02 — одна и та же
// поездка на работу, а часы у них разные.
const HOUR_SPREAD = 1

// Ниже этого числа поездок в окне побеждает случайность: один-единственный
// выезд сделал бы «водителем вторников» того, кто съездил в магазин.
const MIN_SAMPLES = 3

// Догадка нужна уверенная. Половина против половины — это не подсказка, а
// подброшенная монета, и порядок кнопок тогда лучше не трогать.
const MIN_SHARE = 0.6

function hoursApart(left: number, right: number) {
  const direct = Math.abs(left - right)
  return Math.min(direct, 24 - direct)
}

function lead(entries: DriverHistoryEntry[], basis: DriverGuess['basis']): DriverGuess | null {
  if (entries.length < MIN_SAMPLES) return null
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.driver, (counts.get(entry.driver) ?? 0) + 1)
  const [driver, count] = [...counts.entries()].reduce((best, item) => item[1] > best[1] ? item : best)
  const share = count / entries.length
  return share >= MIN_SHARE ? { driver, share, samples: entries.length, basis } : null
}

// Окна пробуются от самого узкого к самому широкому, и первое, где набралось
// достаточно поездок с уверенным большинством, побеждает. Наоборот нельзя:
// человек, который ездит чаще всех вообще, перебил бы того, кто возит детей в
// школу по будням в восемь.
//
// День недели идёт раньше часа не случайно. На боевых данных за месяц вышло
// ровно пятнадцать поездок у каждого из двоих, и час не разделяет их никак —
// оба ездят днём. Зато день разделяет полностью: все пятнадцать поездок одного
// пришлись на субботу и воскресенье, все пятнадцать другого — на будни. Начни
// перебор с часа, и обе догадки утонули бы в ничьей.
export function guessDriver(history: DriverHistoryEntry[], at: DriverMoment): DriverGuess | null {
  const sameHour = history.filter(entry => hoursApart(entry.hour, at.hour) <= HOUR_SPREAD)
  const sameWeekday = history.filter(entry => entry.weekday === at.weekday)
  return lead(sameHour.filter(entry => entry.weekday === at.weekday), 'weekday-hour')
    ?? lead(sameWeekday, 'weekday')
    ?? lead(sameHour, 'hour')
    ?? lead(history, 'overall')
}
