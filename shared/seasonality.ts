import { linearFit, predict, type Fit } from './regression'

// Во что обходится холод. Зимний расход выше летнего у всех, но «выше» — это не
// число: пока не сказано, на сколько литров и на сколько рублей, зимняя цифра
// на карточке выглядит просто плохим месяцем.
//
// Термометра, смотрящего на улицу, в машине нет — есть двигатель, простоявший
// ночь: под утро он показывает температуру воздуха. Из этих ночных минимумов и
// берётся погода месяца.
//
// Сравнивать месяцы напрямую нельзя: холодный месяц обычно ещё и другой по
// езде — короткие городские выезды вместо летних трасс. Поэтому считается не
// разница между месяцами, а наклон: сколько литров на сотню добавляет каждый
// градус, и уже он раскладывается по месяцам в литры и рубли.

// От какой погоды считается надбавка. Плюс пятнадцать — это месяц, в котором
// прогревов уже нет, а кондиционер ещё не спорит с ними за литры.
export const BASE_CELSIUS = 15

export interface SeasonMonth {
  month: string
  // Средняя ночная температура месяца.
  celsius: number | null
  consumption: number | null
  distance: number
  fuelUsed: number
  pricePerLitre: number | null
}

export interface SeasonPremium {
  month: string
  celsius: number
  // Насколько расход этого месяца выше базового по модели, л/100 км.
  extraConsumption: number
  extraLitres: number
  extraCost: number | null
}

export interface Seasonality {
  // Месяцы, у которых есть и расход, и погода.
  months: number
  fit: Fit | null
  // Литров на сотню за каждые десять градусов похолодания.
  litresPerTenDegrees: number | null
  coldest: number | null
  warmest: number | null
  premium: SeasonPremium[]
  extraLitres: number
  extraCost: number | null
  // Надбавка как доля от всего израсходованного за те же месяцы.
  share: number | null
}

const empty = (): Seasonality => ({
  months: 0,
  fit: null,
  litresPerTenDegrees: null,
  coldest: null,
  warmest: null,
  premium: [],
  extraLitres: 0,
  extraCost: null,
  share: null
})

export function summariseSeasonality(months: SeasonMonth[]): Seasonality {
  const usable = months.filter(month =>
    month.celsius != null
    && Number.isFinite(month.celsius)
    && month.consumption != null
    && Number.isFinite(month.consumption)
    && month.distance > 0)
  if (!usable.length) return empty()

  const fit = linearFit(usable.map(month => ({ x: month.celsius!, y: month.consumption! })))
  const coldest = Math.min(...usable.map(month => month.celsius!))
  const warmest = Math.max(...usable.map(month => month.celsius!))

  // Наклон, полученный на пяти тёплых месяцах, не описывает февраль, и
  // раскладывать по нему рубли значило бы придумать их. Пока прямая не
  // пробилась сквозь шум, есть только сама прямая — без выводов.
  if (!fit?.significant) {
    return { ...empty(), months: usable.length, fit, coldest, warmest }
  }

  const premium: SeasonPremium[] = []
  for (const month of usable) {
    // Надбавка — только за холод. Месяц теплее базового не получает
    // отрицательной надбавки: это была бы «экономия от жары», которой в
    // наклоне не измеряли.
    const extraConsumption = Math.max(0, predict(fit, month.celsius!) - predict(fit, BASE_CELSIUS))
    if (extraConsumption <= 0) continue
    const extraLitres = extraConsumption * month.distance / 100
    premium.push({
      month: month.month,
      celsius: month.celsius!,
      extraConsumption,
      extraLitres,
      extraCost: month.pricePerLitre != null ? extraLitres * month.pricePerLitre : null
    })
  }

  const extraLitres = premium.reduce((sum, item) => sum + item.extraLitres, 0)
  const costed = premium.filter(item => item.extraCost != null)
  const fuelUsed = usable.reduce((sum, month) => sum + month.fuelUsed, 0)

  return {
    months: usable.length,
    fit,
    litresPerTenDegrees: -fit.slope * 10,
    coldest,
    warmest,
    premium,
    extraLitres,
    extraCost: costed.length ? costed.reduce((sum, item) => sum + item.extraCost!, 0) : null,
    share: fuelUsed > 0 ? extraLitres / fuelUsed : null
  }
}
