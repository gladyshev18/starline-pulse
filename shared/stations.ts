// Варианты, которые предлагают формы заправок и чеков. Списки общие, чтобы
// значения совпадали на обеих страницах и в базе.
export const STATIONS = [
  { value: 'rosneft', label: 'Роснефть' },
  { value: 'lukoil', label: 'Лукойл' },
  { value: 'other', label: 'Другая АЗС' }
] as const

// «Возврат прихода» — чек на топливо, которое АЗС списала с карты, но не
// налила: его литры и рубли вычитаются из заправки, а не прибавляются к ней.
export const RECEIPT_OPERATIONS = [
  { value: 'purchase', label: 'Покупка' },
  { value: 'refund', label: 'Возврат' }
] as const

export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Наличные' },
  { value: 'card', label: 'Карта' },
  { value: 'unknown', label: 'Не указан' }
] as const

export const FUEL_TYPES = ['АИ-92', 'АИ-95', 'АИ-95 Премиум', 'АИ-98', 'АИ-100'] as const
