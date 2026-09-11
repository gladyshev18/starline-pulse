// Погода за окном по датчику двигателя. Термометра, смотрящего наружу, в машине
// нет, но есть железо, простоявшее несколько часов: остыв, оно принимает
// температуру воздуха. Всё, что здесь считается, — это перевод показаний такого
// датчика в среднесуточную температуру и ночной минимум.

// Надбавка датчика: остаточное тепло и солнце на капоте греют железо сильнее,
// чем воздух вокруг, и надбавка растёт с температурой — по августу и сентябрю
// против архива погоды вышло около нуля на +10 и около пяти градусов на +25.
//
// Отсюда поправка — прямая, подогнанная по 34 суткам наблюдений (СКО 1,3 °C,
// максимальная ошибка 3,5 °C). Минимум в конце нужен для холодов, которых в
// подгонке не было: продлевать прямую вниз нельзя — она начнёт утверждать, что
// железо холоднее воздуха, чего не бывает. Ниже +10 поправка просто выключается,
// и оценкой становится сам датчик.
const SENSOR_SLOPE = 0.75
const SENSOR_OFFSET = 2.6

export function ambientFromEngine(engineCelsius: number) {
  return Math.min(engineCelsius, SENSOR_OFFSET + SENSOR_SLOPE * engineCelsius)
}

// Ночь считается своей прямой: подгонка по среднесуточным на ночной минимум не
// ложится — ночью надбавки от солнца нет вовсе, зато есть остывающее с вечера
// железо. Против архивных ночных минимумов вышло СКО 1,8 °C против 2,3 °C у
// сырого датчика. Смысл у поправки тот же: около нуля, где и решается вопрос про
// заморозки, она выключается.
const NIGHT_SLOPE = 0.7
const NIGHT_OFFSET = 3.5

export function nightAmbientFromEngine(engineCelsius: number) {
  return Math.min(engineCelsius, NIGHT_OFFSET + NIGHT_SLOPE * engineCelsius)
}

// Дневного максимума среди этих величин нет, и не по недосмотру. Днём датчик
// меряет не воздух, а солнце на капоте: против архива погоды часовой максимум
// разошёлся с настоящим на 12 градусов (7 сентября — 56 °C на железе против
// 16,6 °C в воздухе), и никакая прямая этого не чинит — сигнала там просто нет.

// Ночь — с двух до семи: раньше двигатель ещё отдаёт вечернее тепло, позже уже
// встаёт солнце.
export const NIGHT_FROM_HOUR = 2
export const NIGHT_TO_HOUR = 7

// Сколько разных часов суток должно попасть в среднюю и сколько из них — в
// каждую половину суток, чтобы среднюю можно было считать в лоб. Без второго
// условия сутки, когда машина весь день была в разъездах и остыла только к
// ночи, дали бы «среднесуточную» по одной ночи — а это на три градуса холоднее
// правды.
const MIN_HOURS = 8
const MIN_HOURS_PER_HALF = 3

// Сколько часов нужно, чтобы восстанавливать сутки по суточному ходу. Меньше
// шести — это уже не сутки, а несколько замеров подряд.
const MIN_HOURS_ESTIMATED = 6

// Окно, из которого берётся профиль суточного хода, и сколько полных суток в
// нём должно найтись. Профиль сезонный: в сентябре размах между ночью и днём
// семнадцать градусов, в декабре его почти нет, — поэтому соседние двое суток
// описывают день лучше, чем вся история разом.
const PROFILE_NEIGHBOURHOOD_DAYS = 15
const MIN_PROFILE_DAYS = 8

const DAY_MS = 24 * 60 * 60_000

// Показания датчика, уже усреднённые внутри часа. Усреднять надо именно так, а
// не по замерам: стоящую машину опрашивают чаще едущей, и ночь иначе
// перетягивает сутки на себя градуса на три.
export interface AmbientHour {
  day: string
  hour: number
  engine: number
}

export interface AmbientDay {
  day: string
  // Среднесуточная температура воздуха.
  mean: number
  // Ночной минимум тех же суток: он один отвечает на вопрос про заморозки.
  night: number
  // Сколько разных часов суток попало в расчёт.
  hours: number
  // Средняя восстановлена по суточному ходу, а не измерена напрямую: машина
  // была в разъездах и часть часов не оставила показаний.
  estimated: boolean
}

function dayTime(day: string) {
  return Date.parse(`${day}T12:00:00+03:00`)
}

interface DayHours {
  day: string
  at: number
  hours: Map<number, number>
}

function wellCovered(hours: Map<number, number>) {
  if (hours.size < MIN_HOURS) return false
  let first = 0
  let second = 0
  for (const hour of hours.keys()) {
    if (hour < 12) first++
    else second++
  }
  return first >= MIN_HOURS_PER_HALF && second >= MIN_HOURS_PER_HALF
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// Суточный ход: насколько час обычно отличается от средней за свои сутки.
// Строится только по полным суткам — иначе профиль унаследует тот же перекос,
// ради снятия которого его и строят.
function diurnalProfile(days: DayHours[], at: number) {
  const deviations = new Map<number, number[]>()
  let contributors = 0
  for (const day of days) {
    if (Math.abs(day.at - at) > PROFILE_NEIGHBOURHOOD_DAYS * DAY_MS) continue
    if (!wellCovered(day.hours)) continue
    contributors++
    const dayMean = average([...day.hours.values()])
    for (const [hour, value] of day.hours) {
      const bucket = deviations.get(hour)
      if (bucket) bucket.push(value - dayMean)
      else deviations.set(hour, [value - dayMean])
    }
  }
  if (contributors < MIN_PROFILE_DAYS) return null
  return new Map([...deviations].map(([hour, values]) => [hour, average(values)]))
}

// Средняя за неполные сутки. Каждый уцелевший час сначала приводится к «средней
// за сутки» вычитанием его обычного отклонения, и только потом усредняется: без
// этого день, проведённый в разъездах, отдаёт одну ночь и занижает сутки на три
// градуса. На боевых данных приём убирает смещение −3,0 °C и режет СКО с 3,5 до
// 1,9 °C — проверено вырезанием дневных часов у суток, для которых ответ
// известен.
function reconstructMean(hours: Map<number, number>, profile: Map<number, number>) {
  const adjusted: number[] = []
  for (const [hour, value] of hours) {
    const deviation = profile.get(hour)
    if (deviation != null) adjusted.push(value - deviation)
  }
  // Часы, которых профиль не знает, — это часы, в которые машина не стоит
  // никогда. Если такими оказалась половина суток, восстанавливать нечего.
  if (adjusted.length < MIN_HOURS_ESTIMATED || adjusted.length * 2 < hours.size) return null
  return average(adjusted)
}

export function assembleAmbientDays(rows: AmbientHour[]): AmbientDay[] {
  const byDay = new Map<string, DayHours>()
  for (const row of rows) {
    if (!Number.isFinite(row.engine)) continue
    let day = byDay.get(row.day)
    if (!day) {
      day = { day: row.day, at: dayTime(row.day), hours: new Map() }
      byDay.set(row.day, day)
    }
    day.hours.set(row.hour, row.engine)
  }
  const days = [...byDay.values()].sort((left, right) => left.at - right.at)

  const assembled: AmbientDay[] = []
  for (const day of days) {
    // Ночь обязательна. Без часов между двумя и семью «минимум за сутки» —
    // это самый холодный из дневных часов, а он о заморозках не знает ничего.
    const nightHours = [...day.hours].filter(([hour]) => hour >= NIGHT_FROM_HOUR && hour <= NIGHT_TO_HOUR)
    if (!nightHours.length) continue

    const complete = wellCovered(day.hours)
    let mean: number | null = null
    if (complete) {
      mean = average([...day.hours.values()])
    } else if (day.hours.size >= MIN_HOURS_ESTIMATED) {
      const profile = diurnalProfile(days, day.at)
      mean = profile ? reconstructMean(day.hours, profile) : null
    }
    if (mean == null) continue

    assembled.push({
      day: day.day,
      mean: ambientFromEngine(mean),
      night: nightAmbientFromEngine(Math.min(...nightHours.map(([, value]) => value))),
      hours: day.hours.size,
      estimated: !complete
    })
  }
  return assembled
}
