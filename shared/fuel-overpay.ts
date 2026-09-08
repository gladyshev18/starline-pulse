// Во что обошёлся выбор заправки. Вопрос простой: сколько стоил бы весь этот
// бензин, если бы каждый раз он покупался у самой дешёвой из сетей, куда машина
// и так заезжает.
//
// Разовое сравнение средних цен по сетям это не заменяет: средние берутся за
// всё время, а бензин дорожает, и сеть, выглядящая дешёвой, могла просто
// попасться в мае. Поэтому каждая заправка сравнивается с ценами, известными на
// её собственный день, и только с ними.

export interface OverpayFill {
  at: Date
  station: string | null
  stationName: string | null
  fuelType: string | null
  litres: number | null
  pricePerLitre: number | null
  operation: 'purchase' | 'refund'
}

// Цена, которой больше сорока пяти дней, — это цена другого бензина: за
// полтора месяца литр успевает подорожать на пару рублей, и сравнение с такой
// ценой мерило бы инфляцию, а не выбор заправки.
export const PRICE_STALE_DAYS = 45

const DAY_MS = 24 * 60 * 60_000

export interface OverpayPoint {
  at: Date
  station: string | null
  stationName: string | null
  fuelType: string
  litres: number
  price: number
  // Цена самой дешёвой сети, известная на этот день.
  benchmark: number
  benchmarkStation: string | null
  benchmarkStationName: string | null
  amount: number
  // Переплата с начала наблюдений по эту заправку включительно.
  cumulative: number
}

export interface StationOverpay {
  station: string | null
  stationName: string | null
  fills: number
  litres: number
  amount: number
}

export interface FuelOverpay {
  points: OverpayPoint[]
  // Всего переплачено за то, что заправлялись не у самой дешёвой.
  amount: number
  litres: number
  fills: number
  // Сколько потрачено на тот же бензин — чтобы переплату можно было назвать
  // долей, а не только рублями.
  spent: number
  share: number | null
  byStation: StationOverpay[]
  // Заправки, которым не с чем было сравниться: другой сети с этим топливом на
  // тот момент ещё не знали.
  skipped: number
}

const empty = (): FuelOverpay => ({
  points: [],
  amount: 0,
  litres: 0,
  fills: 0,
  spent: 0,
  share: null,
  byStation: [],
  skipped: 0
})

interface KnownPrice {
  at: Date
  price: number
  station: string | null
  stationName: string | null
}

export function summariseOverpay(fills: OverpayFill[]): FuelOverpay {
  const purchases = fills
    .filter(fill => fill.operation !== 'refund')
    .filter(fill => fill.fuelType && fill.pricePerLitre != null && fill.pricePerLitre > 0 && (fill.litres ?? 0) > 0)
    .map(fill => ({ ...fill, at: new Date(fill.at) }))
    .filter(fill => Number.isFinite(fill.at.getTime()))
    .sort((left, right) => left.at.getTime() - right.at.getTime())
  if (!purchases.length) return empty()

  // Последняя известная цена каждой сети по каждому топливу. Заправка видит
  // только то, что было известно к её дню, — сравнивать с ценой, появившейся
  // через неделю, значит требовать от себя прошлого знания будущего.
  const known = new Map<string, KnownPrice>()
  const points: OverpayPoint[] = []
  const byStation = new Map<string, StationOverpay>()
  let cumulative = 0
  let spent = 0
  let litres = 0
  let skipped = 0

  for (const fill of purchases) {
    const fuelType = fill.fuelType!.trim()
    const price = fill.pricePerLitre!
    const volume = fill.litres!
    known.set(`${fuelType}|${fill.station ?? ''}`, {
      at: fill.at,
      price,
      station: fill.station,
      stationName: fill.stationName
    })

    const rivals = [...known.entries()]
      .filter(([key]) => key.startsWith(`${fuelType}|`))
      .map(([, value]) => value)
      .filter(value => (fill.at.getTime() - value.at.getTime()) / DAY_MS <= PRICE_STALE_DAYS)
    // Одна сеть — это не выбор: сравнивать себя с собой можно, но переплатой
    // это не будет.
    const others = rivals.filter(value => value.station !== fill.station)
    if (!others.length) {
      skipped++
      continue
    }

    const cheapest = rivals.reduce((found, value) => value.price < found.price ? value : found)
    const amount = Math.max(0, (price - cheapest.price) * volume)
    cumulative += amount
    spent += price * volume
    litres += volume

    const key = fill.station ?? ''
    const station = byStation.get(key) ?? {
      station: fill.station,
      stationName: fill.stationName,
      fills: 0,
      litres: 0,
      amount: 0
    }
    station.fills++
    station.litres += volume
    station.amount += amount
    station.stationName = station.stationName ?? fill.stationName
    byStation.set(key, station)

    points.push({
      at: fill.at,
      station: fill.station,
      stationName: fill.stationName,
      fuelType,
      litres: volume,
      price,
      benchmark: cheapest.price,
      benchmarkStation: cheapest.station,
      benchmarkStationName: cheapest.stationName,
      amount,
      cumulative
    })
  }

  return {
    points,
    amount: cumulative,
    litres,
    fills: points.length,
    spent,
    share: spent > 0 ? cumulative / spent : null,
    byStation: [...byStation.values()].sort((left, right) => right.amount - left.amount),
    skipped
  }
}
