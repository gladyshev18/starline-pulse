import { kmPerMotorHour } from './service'

// Сколько километров машина проезжает за час работы двигателя. Это не средняя
// скорость: в знаменателе всё время, что мотор крутился, включая прогревы,
// пробки и стояние с включённым зажиганием. Поэтому число отвечает не «как
// быстро ехал», а «сколько из работы двигателя досталось дороге».
//
// Границы взяты из тех же цеховых оценок, что и интервал масла в `service.ts`:
// 70–90 км на моточас — трасса, 30–40 — город без заторов, 10–20 — плотный
// поток. Промежуток между городом и трассой смешанный, отдельного названия у
// него в этих оценках нет.
export const OPERATING_BANDS = [
  { name: 'idle', label: 'Больше стоял', upTo: 20 },
  { name: 'city', label: 'Город', upTo: 40 },
  { name: 'mixed', label: 'Смешанно', upTo: 60 },
  { name: 'highway', label: 'Трасса', upTo: Number.POSITIVE_INFINITY }
] as const

export type OperatingBandName = typeof OPERATING_BANDS[number]['name']

export function operatingBand(kmPerHour: number | null) {
  if (kmPerHour == null || !Number.isFinite(kmPerHour) || kmPerHour <= 0) return null
  return OPERATING_BANDS.find(band => kmPerHour < band.upTo) ?? OPERATING_BANDS.at(-1)!
}

export interface OperatingPeriod {
  // Ключ периода и его границы — считает SQL, называет интерфейс.
  bucket: string
  from: string
  to: string
  km: number
  motorMinutes: number
}

export interface OperatingRate extends OperatingPeriod {
  motorHours: number
  kmPerHour: number | null
  band: typeof OPERATING_BANDS[number] | null
}

// Час работы двигателя — минимум, ниже которого делить бессмысленно: счётчик
// тикает целыми минутами, и на десяти минутах одна минута туда-сюда двигает
// результат на десятую часть.
export const MIN_MOTOR_HOURS = 1

export function operatingRates(periods: OperatingPeriod[]): OperatingRate[] {
  return periods.map(period => {
    const motorHours = period.motorMinutes / 60
    const kmPerHour = motorHours >= MIN_MOTOR_HOURS ? kmPerMotorHour(period.km, motorHours) : null
    return { ...period, motorHours, kmPerHour, band: operatingBand(kmPerHour) }
  })
}

// Насколько неделя выбилась из привычного режима. Сравнивать неделю со средним
// по месяцу, в который она сама и входит, — значит сравнивать её с собой:
// сильная неделя тянет среднее за собой и тем прячет собственное отклонение.
// Поэтому среднее берётся по остальным периодам.
export function operatingDeviation(rates: OperatingRate[], target: OperatingRate) {
  const others = rates.filter(item => item !== target && item.kmPerHour != null)
  if (!others.length || target.kmPerHour == null) return null
  // Взвешивание по моточасам, а не по числу недель: неделя с одним выездом
  // измерена хуже, чем неделя с двадцатью, и весить одинаково им незачем.
  const hours = others.reduce((sum, item) => sum + item.motorHours, 0)
  if (!(hours > 0)) return null
  const average = others.reduce((sum, item) => sum + item.kmPerHour! * item.motorHours, 0) / hours
  if (!(average > 0)) return null
  return target.kmPerHour / average - 1
}
