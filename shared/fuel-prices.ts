// Что происходит с ценой литра. Данные для этого есть только в чеках: датчик
// знает литры, но не рубли, а заправка без чека — это объём без цены.
//
// Разные виды топлива нигде не складываются. АИ-92 и АИ-95 отличаются на
// несколько рублей всегда, и один график на двоих показывал бы не движение
// цены, а то, чем заправлялись в этот раз.

export interface PricedFill {
  purchasedAt: Date | string | number | null
  station: string | null
  stationName: string | null
  fuelType: string | null
  litres: number | null
  pricePerLitre: number | null
  operation: 'purchase' | 'refund'
}

export interface PricePoint {
  at: Date
  price: number
  litres: number | null
  station: string | null
  stationName: string | null
}

export interface FuelTypePrices {
  fuelType: string
  points: PricePoint[]
  first: PricePoint
  last: PricePoint
  // Насколько подорожал литр за то время, что о нём есть чеки.
  change: number | null
  changeShare: number | null
}

export interface StationPrices {
  station: string | null
  stationName: string | null
  fuelType: string
  fills: number
  litres: number
  // Средняя цена, взвешенная литрами: заправка на тридцать литров говорит о
  // потраченных деньгах больше, чем долив на пять.
  averagePrice: number
}

export interface FuelPriceSummary {
  byFuelType: FuelTypePrices[]
  byStation: StationPrices[]
  // Сколько стоила разница в цене между сетями. Считается только там, где один
  // и тот же бензин покупался в разных местах, иначе сравнивать не с чем.
  overpay: Array<{ fuelType: string, litres: number, amount: number, cheapest: StationPrices, dearest: StationPrices }>
}

function timestamp(value: PricedFill['purchasedAt']) {
  if (value == null) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

// Возврат не отдельная покупка, а вычет из уже случившейся: цена в нём та же
// самая, и точкой на графике он был бы двойником своей заправки.
function purchases(fills: PricedFill[]) {
  return fills.filter(fill => fill.operation !== 'refund' && fill.pricePerLitre != null && fill.pricePerLitre > 0)
}

export function summariseFuelPrices(fills: PricedFill[]): FuelPriceSummary {
  const byType = new Map<string, PricePoint[]>()
  const byStation = new Map<string, StationPrices>()

  for (const fill of purchases(fills)) {
    const at = timestamp(fill.purchasedAt)
    const fuelType = fill.fuelType?.trim()
    if (!at || !fuelType) continue
    const point: PricePoint = {
      at,
      price: fill.pricePerLitre!,
      litres: fill.litres,
      station: fill.station,
      stationName: fill.stationName
    }
    byType.set(fuelType, [...(byType.get(fuelType) ?? []), point])

    const key = `${fuelType} ${fill.station ?? ''}`
    const current = byStation.get(key) ?? {
      station: fill.station,
      stationName: fill.stationName,
      fuelType,
      fills: 0,
      litres: 0,
      averagePrice: 0
    }
    // Среднее копится как сумма денег и сумма литров, а делится один раз в
    // конце: среднее из средних завысило бы вклад мелких доливов.
    current.fills++
    current.litres += fill.litres ?? 0
    current.averagePrice += fill.pricePerLitre! * (fill.litres ?? 0)
    current.stationName = current.stationName ?? fill.stationName
    byStation.set(key, current)
  }

  const stations = [...byStation.values()]
    .map(item => ({ ...item, averagePrice: item.litres > 0 ? item.averagePrice / item.litres : 0 }))
    .filter(item => item.litres > 0)
    .sort((left, right) => left.averagePrice - right.averagePrice)

  const byFuelType = [...byType.entries()].map(([fuelType, unsorted]) => {
    const points = [...unsorted].sort((left, right) => left.at.getTime() - right.at.getTime())
    const first = points[0]!
    const last = points.at(-1)!
    return {
      fuelType,
      points,
      first,
      last,
      // Одна-единственная заправка не движение цены, а точка.
      change: points.length > 1 ? last.price - first.price : null,
      changeShare: points.length > 1 && first.price > 0 ? last.price / first.price - 1 : null
    }
  }).sort((left, right) => right.points.length - left.points.length)

  const overpay: FuelPriceSummary['overpay'] = []
  for (const fuelType of byType.keys()) {
    const priced = stations.filter(item => item.fuelType === fuelType)
    if (priced.length < 2) continue
    const cheapest = priced[0]!
    const dearest = priced.at(-1)!
    const litres = priced.reduce((sum, item) => sum + item.litres, 0)
    const spent = priced.reduce((sum, item) => sum + item.averagePrice * item.litres, 0)
    overpay.push({
      fuelType,
      litres,
      // Сколько стоило то, что заправлялись не только у самой дешёвой сети.
      amount: spent - cheapest.averagePrice * litres,
      cheapest,
      dearest
    })
  }

  return { byFuelType, byStation: stations, overpay }
}
