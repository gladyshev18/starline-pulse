import { FUEL_SENSOR_STEP_LITRES } from './fuel'

// Сколько топлива «уходит», пока машина стоит. Датчик округляет до процента
// бака, поэтому ни одна отдельная стоянка ничего не доказывает: ноль или одна
// ступенька — это ровно то, что даёт округление.
//
// Доказывает знак. Если уровень на самом деле не меняется, показание после
// стоянки должно одинаково часто округляться вверх и вниз. Считаются поэтому не
// литры, а стороны: сколько стоянок кончились падением и сколько ростом. Восемь
// падений и ни одного роста при монете — это шанс один к двумстам пятидесяти.

// Короче этого стоянка не в счёт: между двумя поездками подряд уровень просто
// не успевает ни на что отреагировать, а таких пар в разы больше, чем ночей, и
// они бы разбавили выборку нулями.
export const MIN_STANDSTILL_HOURS = 6

export interface StandstillGap {
  hours: number
  // Положительная величина означает, что после стоянки в баке стало меньше.
  delta: number
}

export interface StandstillFuel {
  samples: number
  drops: number
  rises: number
  unchanged: number
  total: number
  average: number | null
  perHour: number | null
  // Вероятность увидеть такой перевес падений над ростами, если уровень на
  // самом деле стоит на месте.
  probability: number | null
  systematic: boolean
}

function choose(n: number, k: number) {
  let result = 1
  for (let index = 0; index < k; index++) result = result * (n - index) / (index + 1)
  return result
}

// Вероятность получить столько же падений или больше при честной монете.
function signTest(drops: number, rises: number) {
  const n = drops + rises
  if (!n) return null
  let tail = 0
  for (let k = drops; k <= n; k++) tail += choose(n, k)
  return tail / 2 ** n
}

export function measureStandstillFuel(gaps: StandstillGap[]): StandstillFuel {
  const usable = gaps.filter(gap => gap.hours >= MIN_STANDSTILL_HOURS && Number.isFinite(gap.delta))
  // Ступенька датчика — половина от того, что он различает, поэтому «ноль» это
  // всё, что меньше половины шага, а не буквальный ноль.
  const threshold = FUEL_SENSOR_STEP_LITRES / 2
  const drops = usable.filter(gap => gap.delta > threshold).length
  const rises = usable.filter(gap => gap.delta < -threshold).length
  const total = usable.reduce((sum, gap) => sum + gap.delta, 0)
  const hours = usable.reduce((sum, gap) => sum + gap.hours, 0)
  const probability = signTest(drops, rises)

  return {
    samples: usable.length,
    drops,
    rises,
    unchanged: usable.length - drops - rises,
    total,
    average: usable.length ? total / usable.length : null,
    perHour: hours > 0 ? total / hours : null,
    probability,
    // Пять процентов — обычная граница, за которой перевес перестают объяснять
    // случайностью. Требование хотя бы четырёх падений добавлено отдельно:
    // три падения без единого роста дают ровно 0,125 и порога не проходят, но
    // формально выглядят убедительно.
    systematic: drops >= 4 && probability != null && probability <= 0.05
  }
}
