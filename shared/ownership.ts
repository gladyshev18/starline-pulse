// Во что обходится километр целиком. Топливо считает `costPerKilometre` по
// балансу бака; здесь к нему добавляется то, что тратится не на литры.
//
// Слагаемых ровно два, и оба берутся из данных, которые и так вводятся:
// заказ-наряды с суммой и одна строка про страховку с налогом. Мойка, омывайка
// и парковка сюда не входят намеренно — см. комментарий у таблицы `fixed_costs`.

export interface ServicePoint {
  performedAt: Date
  mileage: number | null
  amount: number | null
}

export interface ServiceCost {
  costPerKm: number | null
  // Отрезок, на котором посчитано: от первого известного обслуживания до
  // последнего.
  fromMileage: number | null
  toMileage: number | null
  km: number | null
  amount: number
  services: number
}

// Каждый заказ-наряд оплачивает пробег, который к нему привёл, а не тот, что
// будет после. Поэтому сумма самого первого обслуживания в расчёт не идёт:
// неизвестно, сколько машина прошла до него, и делить не на что.
//
// Так же поступает и знаменатель — километры считаются от первого
// обслуживания до последнего. Пробег, накатанный после последней замены,
// ничем ещё не оплачен, и включать его значило бы делать километр дешевле
// ровно по той причине, что до сервиса пока не доехали.
export function serviceCostPerKilometre(points: ServicePoint[]): ServiceCost {
  const known = points
    .filter((point): point is ServicePoint & { mileage: number } => point.mileage != null && Number.isFinite(point.mileage))
    .sort((left, right) => left.mileage - right.mileage)
  const empty = { costPerKm: null, fromMileage: null, toMileage: null, km: null, amount: 0, services: 0 }
  if (known.length < 2) return empty

  const first = known[0]!
  const last = known.at(-1)!
  const km = last.mileage - first.mileage
  if (!(km > 0)) return empty

  const paid = known.slice(1).filter(point => point.amount != null && point.amount > 0)
  const amount = paid.reduce((sum, point) => sum + point.amount!, 0)
  return {
    costPerKm: amount > 0 ? amount / km : null,
    fromMileage: first.mileage,
    toMileage: last.mileage,
    km,
    amount,
    services: paid.length
  }
}

export interface FixedCostPeriod {
  label: string
  amount: number
  startsAt: Date
  endsAt: Date
}

const DAY_MS = 24 * 60 * 60_000

// Сколько из постоянных расходов приходится на этот отрезок. Годовой полис
// входит в август не целиком и не одной двенадцатой, а ровно теми днями,
// которыми август с ним пересёкся: тогда сумма за все месяцы года складывается
// обратно в стоимость полиса.
export function fixedCostForRange(costs: FixedCostPeriod[], start: Date, end: Date) {
  let total = 0
  for (const cost of costs) {
    const days = (cost.endsAt.getTime() - cost.startsAt.getTime()) / DAY_MS
    if (!(days > 0) || !(cost.amount > 0)) continue
    const from = Math.max(cost.startsAt.getTime(), start.getTime())
    const to = Math.min(cost.endsAt.getTime(), end.getTime())
    const overlap = (to - from) / DAY_MS
    if (overlap > 0) total += cost.amount * (overlap / days)
  }
  return total
}

export interface OwnershipInput {
  // Рубли на километр из топлива — уже посчитанные по балансу бака.
  fuelPerKm: number | null
  servicePerKm: number | null
  fixedAmount: number
  distance: number
}

export interface Ownership {
  fuelPerKm: number | null
  servicePerKm: number | null
  fixedPerKm: number | null
  // Переменная стоимость: то, что растёт от каждого следующего километра.
  variablePerKm: number | null
  // Полная: с постоянными расходами, размазанными по этому же пробегу.
  totalPerKm: number | null
}

// Два числа, а не одно, и это принципиально. Переменная стоимость отвечает,
// во что обходится поехать; полная — во что обходится владеть. В месяц с
// малым пробегом они расходятся в разы, и одна общая цифра скрыла бы, что
// подорожал не километр, а простой.
export function ownershipCost(input: OwnershipInput): Ownership {
  const fixedPerKm = input.distance > 0 && input.fixedAmount > 0 ? input.fixedAmount / input.distance : null
  const variable = [input.fuelPerKm, input.servicePerKm].filter((value): value is number => value != null && value > 0)
  const variablePerKm = variable.length ? variable.reduce((sum, value) => sum + value, 0) : null
  const total = [variablePerKm, fixedPerKm].filter((value): value is number => value != null)
  return {
    fuelPerKm: input.fuelPerKm,
    servicePerKm: input.servicePerKm,
    fixedPerKm,
    variablePerKm,
    totalPerKm: total.length ? total.reduce((sum, value) => sum + value, 0) : null
  }
}
