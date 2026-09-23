import { WARM_ENGINE_CELSIUS } from './idle-cost'
import { linearFit, median, predict, type Fit } from './regression'

// Прогревы и холодные пуски — две стороны одного: сколько раз двигатель
// поднимали с холода и во что обходится подъём при той температуре, что была на
// улице.
//
// Уличную температуру в этой машине никто не мерит, но полностью остывший
// двигатель её и показывает: постояв ночь, блок принимает температуру воздуха.
//
// Брать её надо из последнего опроса до пуска, а не из `engine_temp_start`
// сессии. Последняя пишется по первому снимку с зажиганием, а на стоянке машину
// опрашивают раз в шесть минут — к этому моменту двигатель уже поработал и
// нагрелся до 40-60 °C. На боевых данных разница решающая: по `engine_temp_start`
// холодными выглядели 10 пусков из 46, по замеру до пуска — 40, а зависимость
// прогрева от погоды и вовсе меняла знак, потому что «стартовая» температура
// мерила не улицу, а то, сколько двигатель успел проработать до опроса.

export { WARM_ENGINE_CELSIUS }

// Сколько машина должна простоять, чтобы её двигатель считался остывшим до
// уличного. Меньше — и в начале сессии окажется недоостывший блок, который
// приподнимет «погоду» на десяток градусов.
export const COOLED_HOURS = 8

// Ниже этой температуры пуск холодный: смесь ещё обогащается, масло густое, и
// износ идёт тот самый, ради которого холодные пуски и считают.
//
// Рабочие 70 °C, которыми отделяется прогрев от езды, здесь не годятся — они
// завышают счёт вдвое. На боевых данных пусков ниже 70 °C набралось 120 из 210,
// но между 40 и 70 их 64: это возвращение к машине через пару часов, где
// двигатель уже тёплый и греться ему нечего.
export const COLD_START_CELSIUS = 40

// Прогрев дольше этого — не прогрев, а забытая заведённой машина: такие точки
// уводят прямую вверх сильнее, чем весь холод вместе взятый.
export const MAX_WARMUP_MINUTES = 40

export interface EngineStartSession {
  startedAt: Date
  // Температура двигателя по последнему опросу до пуска: у постоявшей машины
  // это и есть погода на улице.
  celsiusBefore: number | null
  engineTempEnd: number | null
  distance: number | null
  durationMinutes: number | null
}

export interface ColdStarts {
  sessions: number
  cold: number
  warm: number
  // Сессии, записанные до того, как начали хранить температуру: они были, но
  // холодными или тёплыми их назвать нельзя.
  unknown: number
  distance: number
  // Холодных пусков на тысячу километров — то, чем месяц городской езды
  // отличается от месяца с дальней дорогой. Именно этот счёт, а не пробег,
  // изнашивает двигатель.
  per1000Km: number | null
  // Поездки, в которых двигатель так и не дошёл до рабочей температуры. Каждая
  // из них — это весь износ холодного пуска без единого километра «здоровой»
  // езды.
  neverWarm: number
  neverWarmDistance: number
}

export function summariseColdStarts(sessions: EngineStartSession[]): ColdStarts {
  const distance = sessions.reduce((sum, session) => sum + (session.distance ?? 0), 0)
  const cold = sessions.filter(session =>
    session.celsiusBefore != null && session.celsiusBefore < COLD_START_CELSIUS)
  const warm = sessions.filter(session =>
    session.celsiusBefore != null && session.celsiusBefore >= COLD_START_CELSIUS)
  // «Не прогрелся» спрашивается только с холодных пусков: сессия, начатая на
  // горячем двигателе, прогреваться и не должна.
  const neverWarm = cold.filter(session =>
    session.engineTempEnd != null && session.engineTempEnd < WARM_ENGINE_CELSIUS)

  return {
    sessions: sessions.length,
    cold: cold.length,
    warm: warm.length,
    unknown: sessions.filter(session => session.celsiusBefore == null).length,
    distance,
    per1000Km: distance > 0 ? cold.length / distance * 1000 : null,
    neverWarm: neverWarm.length,
    neverWarmDistance: neverWarm.reduce((sum, session) => sum + (session.distance ?? 0), 0)
  }
}

// Что значит счёт холодных пусков. Само число ничего не говорит: 70 пусков
// за месяц — много или мало, зависит от того, сколько после каждого проехали.
// Мерилом служит регламент ТО: поездки короче 8 км, а в мороз короче 16 км,
// там записаны в тяжёлые условия, при которых масло меняют вдвое чаще. Масло
// за такую поездку не успевает выпарить воду и бензин, попавшие в него при
// холодном пуске.
export const SHORT_TRIP_KM = 8
export const SHORT_TRIP_FROST_KM = 16

export interface ColdStartVerdict {
  // Сколько километров в среднем приходится на один холодный пуск.
  kmPerStart: number
  // Порог короткой поездки для погоды месяца.
  thresholdKm: number
  frost: boolean
  severe: boolean
  // Доля холодных пусков, после которых двигатель так и не прогрелся.
  neverWarmShare: number
}

export function coldStartVerdict(summary: ColdStarts, nightCelsius: number | null): ColdStartVerdict | null {
  if (!summary.cold || summary.distance <= 0) return null
  const kmPerStart = summary.distance / summary.cold
  const frost = nightCelsius != null && nightCelsius < 0
  const thresholdKm = frost ? SHORT_TRIP_FROST_KM : SHORT_TRIP_KM
  return {
    kmPerStart,
    thresholdKm,
    frost,
    severe: kmPerStart < thresholdKm,
    neverWarmShare: summary.neverWarm / summary.cold
  }
}

export interface WarmupSample {
  at: Date
  // Температура двигателя в момент пуска — она же уличная, раз машина остыла.
  celsius: number
  // Минуты от запуска до того, как машина поехала.
  minutes: number
}

export interface WarmupForecast {
  celsius: number
  minutes: number
  litres: number | null
  cost: number | null
}

export interface WarmupModel {
  samples: number
  // Средний прогрев за всё время — то, что можно сказать, даже когда
  // зависимости от холода ещё не видно.
  averageMinutes: number | null
  medianMinutes: number | null
  // Прямая «минуты от градусов». Наклон отрицательный: чем холоднее, тем
  // дольше.
  fit: Fit | null
  // Минут прогрева на каждые десять градусов холода — тот же наклон, но в виде,
  // который можно произнести вслух.
  minutesPerTenDegrees: number | null
  coldest: number | null
  warmest: number | null
  forecast: WarmupForecast[]
}

const empty = (): WarmupModel => ({
  samples: 0,
  averageMinutes: null,
  medianMinutes: null,
  fit: null,
  minutesPerTenDegrees: null,
  coldest: null,
  warmest: null,
  forecast: []
})

// Температуры, для которых показывается прогноз. Ниже наблюдённого холода
// прямая не продлевается: прогрев в мороз не продолжение осенней прямой, он
// упирается в свои законы, и обещать по ней «минус двадцать» нечестно.
const FORECAST_STEPS = [-20, -10, 0, 10, 20]

export interface WarmupCost {
  litresPerHour: number
  pricePerLitre: number | null
}

export function warmupModel(samples: WarmupSample[], cost: WarmupCost | null = null): WarmupModel {
  const usable = samples.filter(sample =>
    Number.isFinite(sample.celsius)
    && Number.isFinite(sample.minutes)
    && sample.minutes > 0
    && sample.minutes <= MAX_WARMUP_MINUTES)
  if (!usable.length) return empty()

  const minutes = usable.map(sample => sample.minutes)
  const fit = linearFit(usable.map(sample => ({ x: sample.celsius, y: sample.minutes })))
  const coldest = Math.min(...usable.map(sample => sample.celsius))
  const warmest = Math.max(...usable.map(sample => sample.celsius))

  const priced = (celsius: number, predicted: number): WarmupForecast => {
    const litres = cost ? predicted / 60 * cost.litresPerHour : null
    return {
      celsius,
      minutes: predicted,
      litres,
      cost: litres != null && cost?.pricePerLitre != null ? litres * cost.pricePerLitre : null
    }
  }

  // Прогноз строится только по значимой прямой и только внутри той погоды,
  // которую машина уже видела. Всё остальное было бы не прогнозом, а
  // продолжением случайного наклона в мороз, где он неверен вдвойне.
  const forecast = fit?.significant
    ? FORECAST_STEPS
      .filter(value => value >= coldest && value <= warmest)
      .map(value => priced(value, Math.max(0, predict(fit, value))))
    : []

  return {
    samples: usable.length,
    averageMinutes: minutes.reduce((sum, value) => sum + value, 0) / minutes.length,
    medianMinutes: median(minutes),
    fit,
    minutesPerTenDegrees: fit?.significant ? -fit.slope * 10 : null,
    coldest,
    warmest,
    forecast
  }
}
