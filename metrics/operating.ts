import { sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { vehicleSnapshots } from '../db/schema'
import { operatingRates, type OperatingPeriod, type OperatingRate } from '../shared/operating'

// Шаг счётчика больше этого — сброс моточасов или мусор, а не работа двигателя:
// `motorhours_reset` есть в списке функций устройства, и после него значение
// падает, а следующее приращение оказывается огромным.
const MAX_MOTOR_STEP_MINUTES = 720

// Одометр досылается кусками по десять-двадцать километров, но между двумя
// опросами больше суток пути не случается. Граница здесь только против
// испорченного показания.
const MAX_MILEAGE_STEP_KM = 1000

export type OperatingUnit = 'week' | 'day'

const BUCKET_FORMAT: Record<OperatingUnit, string> = {
  // %W — неделя с понедельника, как считает и календарь: неделя должна начинаться
  // там же, где у человека, иначе «неделя отпуска» разъедется на две.
  week: '%Y-%W',
  day: '%Y-%m-%d'
}

// Километры и моточасы одного периода. Оба числа — суммы приращений, а не
// разность краёв: разность проглотила бы сброс счётчика целиком, а приращение
// после сброса просто отрицательное и в сумму не попадает.
//
// Считается по снапшотам, а не по поездкам, и в этом весь смысл: счётчик
// моточасов не может пропустить запуск, который проспал опрос, а сумма
// длительностей поездок — может.
export async function operatingPeriods(
  database: Database,
  vehicleId: number,
  start: Date,
  end: Date,
  unit: OperatingUnit = 'week'
): Promise<OperatingPeriod[]> {
  const format = BUCKET_FORMAT[unit]
  const rows = await database.all<{ bucket: string, from_day: string, to_day: string, minutes: number, km: number }>(sql`
    with steps as (
      select
        ${vehicleSnapshots.ts} as ts,
        ${vehicleSnapshots.motorMinutes} as motor,
        ${vehicleSnapshots.mileage} as mileage,
        lag(${vehicleSnapshots.motorMinutes}) over (order by ${vehicleSnapshots.ts}) as prev_motor,
        lag(${vehicleSnapshots.mileage}) over (order by ${vehicleSnapshots.ts}) as prev_mileage
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${vehicleId}
        and ${vehicleSnapshots.ts} >= ${start.getTime()}
        and ${vehicleSnapshots.ts} < ${end.getTime()}
    )
    select
      strftime(${format}, ts / 1000, 'unixepoch', '+3 hours') as bucket,
      min(date(ts / 1000, 'unixepoch', '+3 hours')) as from_day,
      max(date(ts / 1000, 'unixepoch', '+3 hours')) as to_day,
      coalesce(sum(case
        when prev_motor is not null and motor > prev_motor and motor - prev_motor <= ${MAX_MOTOR_STEP_MINUTES}
        then motor - prev_motor else 0 end), 0) as minutes,
      coalesce(sum(case
        when prev_mileage is not null and mileage > prev_mileage and mileage - prev_mileage <= ${MAX_MILEAGE_STEP_KM}
        then mileage - prev_mileage else 0 end), 0) as km
    from steps
    group by bucket
    order by bucket
  `)

  return rows.map(row => ({
    bucket: String(row.bucket),
    from: String(row.from_day),
    to: String(row.to_day),
    km: Number(row.km || 0),
    motorMinutes: Number(row.minutes || 0)
  }))
}

export interface OperatingSummary {
  periods: OperatingRate[]
  // Весь отрезок одной строкой. Считается из тех же приращений, а не как среднее
  // недельных значений: неделя с одним выездом иначе весила бы столько же,
  // сколько неделя с двадцатью.
  total: OperatingRate
}

export async function operatingSummary(
  database: Database,
  vehicleId: number,
  start: Date,
  end: Date,
  unit: OperatingUnit = 'week'
): Promise<OperatingSummary> {
  const periods = await operatingPeriods(database, vehicleId, start, end, unit)
  const km = periods.reduce((sum, item) => sum + item.km, 0)
  const motorMinutes = periods.reduce((sum, item) => sum + item.motorMinutes, 0)
  const [total] = operatingRates([{
    bucket: 'total',
    from: periods[0]?.from ?? '',
    to: periods.at(-1)?.to ?? '',
    km,
    motorMinutes
  }])
  return { periods: operatingRates(periods), total: total! }
}
