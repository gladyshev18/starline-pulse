import { and, eq } from 'drizzle-orm'
import { serviceEvents } from '../../../db/schema'

// Править можно только сумму шиномонтажа. Бот записывает смену резины в день
// переобувания, когда чека ещё нет под рукой, а сумма доносится позже — и это
// единственное, что у такой записи приходит с опозданием. Остальные поля
// фиксируют момент и показание одометра, и менять их задним числом значит
// переписывать пробег соседних сезонов.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор записи' })
  }

  const body = await readBody<{ amount?: unknown }>(event)
  const raw = body?.amount
  let amount: number | null = null
  if (raw != null && raw !== '') {
    const parsed = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.').replace(/\s/g, ''))
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000_000) {
      throw createError({ statusCode: 400, statusMessage: 'Укажите корректную сумму' })
    }
    amount = Math.round(parsed * 100) / 100
  }

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  const where = and(eq(serviceEvents.id, id), eq(serviceEvents.vehicleId, vehicle.id), eq(serviceEvents.kind, 'tyres'))
  const [updated] = await database.update(serviceEvents).set({ amount, updatedAt: new Date() }).where(where).returning()
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Запись не найдена' })
  return updated
})
