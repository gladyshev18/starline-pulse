// Рубли за бензин приходят не от датчика, а от чеков: литры в баке видит
// сигнализация, а сумму знает только тот чек, который к заправке привязали.
// Поэтому деньги и литры считаются по разным наборам заправок, и держать это в
// одном месте важнее, чем сэкономить запрос: и главная, и статистика, и
// помесячные графики должны называть один и тот же август одной суммой.

export interface RefuelMoney {
  litresAdded: number | null
  totalAmount: number | null
}

export interface FuelSpend {
  // Ноль рублей читался бы как месяц без заправок, поэтому месяц без единого
  // чека остаётся без суммы вовсе.
  amount: number | null
  // Заправок с суммой — ровно те, что сложились в `amount`.
  refuels: number
  // И те, что в неё не вошли: бак они наполнили, а чека к ним нет.
  unknown: number
  // Литры оплаченных заправок: цена литра делит сумму ровно на тот бензин, за
  // который эта сумма заплачена.
  litres: number
  pricePerLitre: number | null
  total: number
}

export function summariseFuelSpend(refuels: RefuelMoney[]): FuelSpend {
  const paid = refuels.filter(item => item.totalAmount != null)
  const amount = paid.reduce((sum, item) => sum + item.totalAmount!, 0)
  const litres = paid.reduce((sum, item) => sum + (item.litresAdded ?? 0), 0)

  return {
    amount: paid.length ? amount : null,
    refuels: paid.length,
    unknown: refuels.length - paid.length,
    litres,
    pricePerLitre: paid.length > 0 && litres > 0 ? amount / litres : null,
    total: refuels.length
  }
}
