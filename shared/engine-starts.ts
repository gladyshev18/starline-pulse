import { linearFit, median, type Fit } from './regression'

// Здоровье пуска. Времени прокрутки стартера в данных нет и не будет: журнал
// сигнализации присылает «зажигание включено» и «двигатель запущен» с разницей
// в одну-две секунды на каждом из ста восьмидесяти циклов — это не измерение, а
// два кода одного и того же события. При автозапуске приходит ещё «начал
// заводиться», и до «запущен» от него ровно восемь секунд в двадцати случаях из
// двадцати шести: это фиксированная пауза сигнализации, а не то, сколько
// крутился стартер.
//
// Зато отлично видно напряжение перед пуском: на стоянке опрос показывает
// 12,5–13,0 В, на заведённой машине — 14,4 В от генератора. Напряжение покоя и
// есть то, что предсказывает незаводящееся утро, и следить надо за ним.

// Простоявшая машина отдаёт напряжение покоя; сразу после поездки на клеммах
// висит поверхностный заряд от генератора, и те же 12,9 В не значат ничего.
// Шести часов хватает, чтобы он сошёл.
export const RESTED_HOURS = 6

// Свинцовый аккумулятор в покое: 12,7 В — полный заряд, 12,4 — примерно три
// четверти, 12,0 — половина и меньше. Ниже первой границы пуск ещё случится, но
// уже есть о чём говорить; ниже второй зимнее утро становится лотереей.
export const LOW_REST_VOLTS = 12.4
export const CRITICAL_REST_VOLTS = 12.0

const DAY_MS = 24 * 60 * 60_000

export interface StartSample {
  at: Date
  // Автозапуск: перед «двигатель запущен» пришло «начал заводиться», а машина
  // осталась под охраной.
  remote: boolean
  // Последнее показание вольтметра до пуска, снятое на заглушенной машине.
  restVolts: number | null
  // Сколько машина простояла перед этим пуском.
  restedHours: number | null
  // Температура двигателя в момент пуска. У полностью остывшего это уличная
  // температура, а холод и есть то, из-за чего напряжение проседает.
  engineTemp: number | null
  crankSeconds: number | null
}

export interface StartHealth {
  starts: number
  remote: number
  manual: number
  voltage: {
    // В оценку идут только пуски после долгой стоянки — см. `RESTED_HOURS`.
    samples: number
    average: number | null
    lowest: number | null
    low: number
    critical: number
    // Куда едет напряжение покоя. Вольты за тридцать суток: за месяц наблюдений
    // здоровая батарея не двигается вовсе, а умирающая теряет десятые.
    trend: Fit | null
    perMonth: number | null
    // Насколько напряжение объясняется холодом. Пока значимой зависимости нет,
    // просадку нельзя списать на погоду.
    byTemperature: Fit | null
  }
  crank: {
    samples: number
    seconds: number | null
  }
}

const empty = (): StartHealth => ({
  starts: 0,
  remote: 0,
  manual: 0,
  voltage: { samples: 0, average: null, lowest: null, low: 0, critical: 0, trend: null, perMonth: null, byTemperature: null },
  crank: { samples: 0, seconds: null }
})

export function summariseStarts(samples: StartSample[]): StartHealth {
  if (!samples.length) return empty()

  const rested = samples.filter(sample =>
    sample.restVolts != null
    && Number.isFinite(sample.restVolts)
    && sample.restedHours != null
    && sample.restedHours >= RESTED_HOURS)
  const volts = rested.map(sample => sample.restVolts!)

  // Ось времени — сутки от первого пуска выборки, чтобы наклон читался в
  // вольтах за месяц, а не в вольтах за миллисекунду.
  const from = Math.min(...samples.map(sample => sample.at.getTime()))
  const trend = linearFit(rested.map(sample => ({
    x: (sample.at.getTime() - from) / DAY_MS,
    y: sample.restVolts!
  })))
  const byTemperature = linearFit(rested
    .filter(sample => sample.engineTemp != null)
    .map(sample => ({ x: sample.engineTemp!, y: sample.restVolts! })))

  const cranks = samples.map(sample => sample.crankSeconds).filter((value): value is number => value != null)

  return {
    starts: samples.length,
    remote: samples.filter(sample => sample.remote).length,
    manual: samples.filter(sample => !sample.remote).length,
    voltage: {
      samples: volts.length,
      average: volts.length ? volts.reduce((sum, value) => sum + value, 0) / volts.length : null,
      lowest: volts.length ? Math.min(...volts) : null,
      low: volts.filter(value => value < LOW_REST_VOLTS).length,
      critical: volts.filter(value => value < CRITICAL_REST_VOLTS).length,
      trend,
      // Незначимый наклон наружу не выдаётся вовсе: «−0,03 В в месяц» на
      // десятке точек читается как приговор батарее, хотя это разброс.
      perMonth: trend?.significant ? trend.slope * 30 : null,
      byTemperature
    },
    crank: { samples: cranks.length, seconds: median(cranks) }
  }
}
