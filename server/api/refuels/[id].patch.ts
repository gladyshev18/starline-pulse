import { and, eq } from 'drizzle-orm'
import { refuelEvents } from '../../../db/schema'
import { completeReceiptAmounts } from '../../../receipts/fields'

const stations = ['rosneft', 'lukoil', 'other'] as const

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createError({ statusCode: 400, statusMessage: `Заполните поле «${field}»` })
  }
  const result = value.trim()
  if (result.length > maxLength) {
    throw createError({ statusCode: 400, statusMessage: `Поле «${field}» не должно превышать ${maxLength} символов` })
  }
  return result
}

function optionalAmount(value: unknown, field: string, maximum: number) {
  if (value == null || value === '') return null
  const result = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  if (!Number.isFinite(result) || result <= 0 || result > maximum) {
    throw createError({ statusCode: 400, statusMessage: `Укажите корректное значение поля «${field}»` })
  }
  return Math.round(result * 100) / 100
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор заправки' })
  }

  const body = await readBody<{
    station?: unknown
    stationName?: unknown
    fuelType?: unknown
    pricePerLitre?: unknown
    totalAmount?: unknown
  }>(event)
  if (typeof body?.station !== 'string' || !stations.includes(body.station as typeof stations[number])) {
    throw createError({ statusCode: 400, statusMessage: 'Выберите АЗС' })
  }

  const station = body.station as typeof stations[number]
  const stationName = station === 'other' ? requiredText(body.stationName, 'Название АЗС', 100) : null
  const fuelType = requiredText(body.fuelType, 'Вид топлива', 50)

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  const where = and(eq(refuelEvents.id, id), eq(refuelEvents.vehicleId, vehicle.id))
  const [refuel] = await database.select().from(refuelEvents).where(where).limit(1)
  if (!refuel) throw createError({ statusCode: 404, statusMessage: 'Заправка не найдена' })

  // On the receipt you often have only the total; the volume is already known
  // from the sensor, so the price per litre follows from the two of them.
  const { litres, pricePerLitre, totalAmount } = completeReceiptAmounts({
    litres: refuel.litresAdded,
    pricePerLitre: optionalAmount(body.pricePerLitre, 'Цена за литр', 10_000),
    totalAmount: optionalAmount(body.totalAmount, 'Сумма', 10_000_000)
  })
  if (pricePerLitre == null && totalAmount == null) {
    throw createError({ statusCode: 400, statusMessage: 'Укажите сумму или цену за литр' })
  }

  await database.update(refuelEvents).set({ station, stationName, fuelType, pricePerLitre, totalAmount }).where(where)
  return { id, station, stationName, fuelType, pricePerLitre, totalAmount, litresAdded: litres }
})
