// Кто был за рулём, знает только бот: он спрашивает после каждой поездки, и на
// вопрос могли не ответить. Разбивка нужна и в отчётах, и в статистике, поэтому
// живёт отдельно от обоих — иначе два места считали бы одни и те же километры
// по-разному.

export interface DriverTrips {
  driver: string | null
  trips: number
  distance: number
  fuelUsed: number
  minutes: number
}

export interface DriverTotals extends DriverTrips {
  consumption: number | null
  share: number
}

// Поездки без ответа сходятся в одну строку и уходят вниз: они не водитель, с
// которым можно сравнивать, а остаток, который к водителям не привязался.
export function summariseByDriver(rows: DriverTrips[]): DriverTotals[] {
  const totals = new Map<string, DriverTrips>()
  for (const row of rows) {
    const driver = row.driver?.trim() || null
    const current = totals.get(driver ?? '') ?? { driver, trips: 0, distance: 0, fuelUsed: 0, minutes: 0 }
    current.trips += row.trips
    current.distance += row.distance
    current.fuelUsed += row.fuelUsed
    current.minutes += row.minutes
    totals.set(driver ?? '', current)
  }

  const driven = [...totals.values()].reduce((sum, row) => sum + row.distance, 0)
  return [...totals.values()]
    .map(row => ({
      ...row,
      consumption: row.distance > 0 && row.fuelUsed > 0 ? row.fuelUsed / row.distance * 100 : null,
      share: driven > 0 ? row.distance / driven : 0
    }))
    .sort((left, right) => {
      if (!left.driver !== !right.driver) return left.driver ? -1 : 1
      return right.distance - left.distance
    })
}

// Одна строка «Не указан» на весь месяц — это не разбивка, а сообщение о том,
// что на вопрос бота ни разу не ответили. Такую таблицу лучше не рисовать.
export function hasNamedDriver(rows: DriverTotals[]) {
  return rows.some(row => row.driver)
}
