// Прямая по облаку точек — там, где одна величина объясняется другой: минуты
// прогрева температурой на улице, расход — той же температурой, смещение
// датчика — прожитым временем.
//
// Метод обычный (наименьшие квадраты), а вот отдавать его результат наружу
// голым нельзя. На десятке точек с узким разбросом икса прямая проводится
// всегда, и наклон у неё всегда ненулевой — просто потому, что ровно нулевым он
// не выходит никогда. Поэтому вместе с наклоном считается его собственная
// ошибка, и есть `significant`: наклон, который меньше двух своих ошибок, — это
// не зависимость, а то, как легли случайные точки.

export interface Point {
  x: number
  y: number
}

export interface Fit {
  // y = intercept + slope * x
  slope: number
  intercept: number
  points: number
  // Доля разброса игрека, которую объясняет икс.
  r2: number
  // Стандартная ошибка наклона.
  slopeError: number | null
  // Наклон больше двух своих ошибок: зависимость видно сквозь шум.
  significant: boolean
  minX: number
  maxX: number
}

// Меньше трёх точек — это не облако: через две прямая проходит точно, и ошибку
// наклона на них считать не из чего.
export const MIN_FIT_POINTS = 3

export function linearFit(points: Point[]): Fit | null {
  const usable = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (usable.length < MIN_FIT_POINTS) return null

  const n = usable.length
  const meanX = usable.reduce((sum, point) => sum + point.x, 0) / n
  const meanY = usable.reduce((sum, point) => sum + point.y, 0) / n
  const varianceX = usable.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
  // Икс без разброса не объясняет ничего: все точки стоят на одной вертикали.
  if (varianceX <= 0) return null

  const covariance = usable.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0)
  const slope = covariance / varianceX
  const intercept = meanY - slope * meanX

  const varianceY = usable.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0)
  const residual = usable.reduce((sum, point) => sum + (point.y - (intercept + slope * point.x)) ** 2, 0)
  const r2 = varianceY > 0 ? Math.max(0, 1 - residual / varianceY) : 0

  // Ошибка наклона — разброс остатков, разложенный по разбросу икса. На трёх
  // точках знаменатель степеней свободы равен единице, и ошибка честно выходит
  // огромной: столько точек и правда ничего не доказывают.
  const slopeError = n > 2 ? Math.sqrt(residual / (n - 2) / varianceX) : null

  return {
    slope,
    intercept,
    points: n,
    r2,
    slopeError,
    // Прямая, на которой точки лежат в точности, не имеет ошибки наклона
    // вовсе — и она же самая значимая из возможных, поэтому нулевую ошибку
    // нельзя путать с «не посчитали».
    significant: slopeError != null && slope !== 0 && Math.abs(slope) > 2 * slopeError,
    minX: Math.min(...usable.map(point => point.x)),
    maxX: Math.max(...usable.map(point => point.x))
  }
}

// Значение прямой в точке. Отдельной функцией, а не методом объекта: прямая
// уезжает на страницу через JSON, а метод по дороге теряется.
export function predict(fit: Fit, x: number) {
  return fit.intercept + fit.slope * x
}

// Среднее и его ошибка — то же самое для случая, когда объяснять нечем и
// остаётся только сказать, сколько обычно выходит.
export function average(values: number[]) {
  const usable = values.filter(value => Number.isFinite(value))
  if (!usable.length) return null
  const mean = usable.reduce((sum, value) => sum + value, 0) / usable.length
  if (usable.length < 2) return { mean, error: null, samples: usable.length }
  const variance = usable.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (usable.length - 1)
  return { mean, error: Math.sqrt(variance / usable.length), samples: usable.length }
}

export function median(values: number[]) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
