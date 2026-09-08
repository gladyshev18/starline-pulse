// Что можно смотреть помесячно. Список один на страницу и на график: подписи
// переключателя, единицы оси и формат подсказки должны совпадать, иначе ось
// однажды окажется в литрах, а заголовок над ней — в рублях.

export type MonthlyMetricValue =
  | 'distance'
  | 'trips'
  | 'fuelUsed'
  | 'consumption'
  | 'spend'
  | 'pricePerLitre'
  | 'costPerKm'

export interface MonthlyMetric {
  value: MonthlyMetricValue
  // Короткая подпись на кнопке и полная — над графиком.
  label: string
  title: string
  unit: string
  hint: string
  kind: 'bar' | 'line'
  digits: number
  money: boolean
  // Ноль на оси: у пробега он значит «не ездили», а у цены литра — ничего, и
  // от нуля движение цены на пару рублей превращается в прямую линию.
  zero: boolean
}

export const MONTHLY_METRICS: readonly MonthlyMetric[] = [
  {
    value: 'distance',
    label: 'Пробег',
    title: 'Пробег по месяцам',
    unit: 'км',
    hint: 'Километры завершённых поездок за месяц',
    kind: 'bar',
    digits: 0,
    money: false,
    zero: true
  },
  {
    value: 'trips',
    label: 'Поездки',
    title: 'Поездки по месяцам',
    unit: '',
    hint: 'Сколько раз за месяц машина куда-то съездила',
    kind: 'bar',
    digits: 0,
    money: false,
    zero: true
  },
  {
    value: 'fuelUsed',
    label: 'Топливо',
    title: 'Израсходовано по месяцам',
    unit: 'л',
    hint: 'Литры по балансу бака — с прогревами и тем, что не досталось ни одной поездке',
    kind: 'bar',
    digits: 1,
    money: false,
    zero: true
  },
  {
    value: 'consumption',
    label: 'Расход',
    title: 'Средний расход по месяцам',
    unit: 'л/100 км',
    hint: 'Те же литры на сто километров: зимой месяц дороже того же летнего',
    kind: 'line',
    digits: 1,
    money: false,
    zero: false
  },
  {
    value: 'spend',
    label: 'Затраты',
    title: 'Затраты на бензин по месяцам',
    unit: '₽',
    hint: 'Рубли по чекам месяца — у заправок без чека суммы нет, и в столбец они не попадают',
    kind: 'bar',
    digits: 0,
    money: true,
    zero: true
  },
  {
    value: 'pricePerLitre',
    label: 'Цена литра',
    title: 'Цена литра по месяцам',
    unit: '₽/л',
    hint: 'Средняя по чекам месяца. Месяц без чеков остаётся дырой: подставлять туда прошлую цену нечестно',
    kind: 'line',
    digits: 2,
    money: true,
    zero: false
  },
  {
    value: 'costPerKm',
    label: 'Километр',
    title: 'Стоимость километра по месяцам',
    unit: '₽/км',
    hint: 'Топливная часть километра: литры месяца по цене месяца',
    kind: 'line',
    digits: 2,
    money: true,
    zero: false
  }
]

export function monthlyMetric(value: string): MonthlyMetric {
  return MONTHLY_METRICS.find(item => item.value === value) ?? MONTHLY_METRICS[0]!
}
