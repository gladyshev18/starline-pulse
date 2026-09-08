import { FUEL_SENSOR_STEP_LITRES } from './idle-cost'
import { linearFit, type Fit } from './regression'

// The rounding error of one comparison is bounded by a whole step, so a single
// refuel showing exactly one step of offset is not evidence of anything — it is
// one extreme draw. Only when several refuels agree does the average of bounded
// errors concentrate enough for the offset to be the sensor rather than chance.
export const MIN_DRIFT_SAMPLES = 4

export interface DriftSample {
  sensorLitres: number | null
  receiptLitres: number | null
  percentAfter: number | null
}

export interface SensorDrift {
  samples: number
  // Refuels that filled the tank: the gauge cannot read past full, so whatever
  // the last litres did is invisible and the comparison would only measure the
  // ceiling.
  saturated: number
  // Positive means the sensor claims more litres than the receipt sold.
  bias: number | null
  uncertainty: number | null
  systematic: boolean
}

export function measureSensorDrift(samples: DriftSample[]): SensorDrift {
  let saturated = 0
  const differences: number[] = []
  for (const sample of samples) {
    if (sample.sensorLitres == null || sample.receiptLitres == null) continue
    if (sample.percentAfter != null && sample.percentAfter >= 100) {
      saturated++
      continue
    }
    differences.push(sample.sensorLitres - sample.receiptLitres)
  }
  if (!differences.length) return { samples: 0, saturated, bias: null, uncertainty: null, systematic: false }

  const bias = differences.reduce((sum, value) => sum + value, 0) / differences.length
  // Each volume is a difference of two readings rounded to the sensor's step, so
  // it carries two independent rounding errors; averaging over the refuels
  // shrinks that by the square root of their number.
  const readingError = FUEL_SENSOR_STEP_LITRES / Math.sqrt(12)
  const uncertainty = readingError * Math.sqrt(2) / Math.sqrt(differences.length)
  return {
    samples: differences.length,
    saturated,
    bias,
    uncertainty,
    // Below twice its own error the offset is indistinguishable from rounding.
    systematic: differences.length >= MIN_DRIFT_SAMPLES && Math.abs(bias) > 2 * uncertainty
  }
}

// Смещение — величина не мгновенная, а накопленная: датчик может врать
// одинаково с самого начала, а может расходиться с чеками всё сильнее, и это
// два разных диагноза. Второе видно только по времени, поэтому те же разницы
// раскладываются ещё и по датам.
//
// Точек здесь всегда мало — их ровно столько, сколько заправок с чеком, —
// поэтому наклон отдаётся наружу только значимым. Иначе «литр в месяц» вырастал
// бы из четырёх заправок, три из которых округлились в одну сторону.
export interface DriftPoint {
  at: Date
  difference: number
}

export interface DriftTrend {
  points: DriftPoint[]
  fit: Fit | null
  // Литров в месяц: на столько датчик расходится с чеками за тридцать суток.
  perMonth: number | null
  days: number
}

export interface DatedDriftSample extends DriftSample {
  at: Date
}

export function measureDriftTrend(samples: DatedDriftSample[]): DriftTrend {
  const points: DriftPoint[] = []
  for (const sample of samples) {
    if (sample.sensorLitres == null || sample.receiptLitres == null) continue
    if (sample.percentAfter != null && sample.percentAfter >= 100) continue
    const at = new Date(sample.at)
    if (!Number.isFinite(at.getTime())) continue
    points.push({ at, difference: sample.sensorLitres - sample.receiptLitres })
  }
  points.sort((left, right) => left.at.getTime() - right.at.getTime())
  if (!points.length) return { points, fit: null, perMonth: null, days: 0 }

  const from = points[0]!.at.getTime()
  const days = (points.at(-1)!.at.getTime() - from) / (24 * 60 * 60_000)
  const fit = linearFit(points.map(point => ({
    x: (point.at.getTime() - from) / (24 * 60 * 60_000),
    y: point.difference
  })))

  return { points, fit, perMonth: fit?.significant ? fit.slope * 30 : null, days }
}
