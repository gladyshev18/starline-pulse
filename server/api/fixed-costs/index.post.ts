import { fixedCosts } from '../../../db/schema'

const KINDS = ['insurance', 'tax', 'other'] as const
type Kind = typeof KINDS[number]

const YEAR_MS = 365 * 24 * 60 * 60_000

function kind(value: unknown): Kind {
  return KINDS.includes(value as Kind) ? value as Kind : 'other'
}

function amount(value: unknown) {
  const result = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'))
  if (!Number.isFinite(result) || result <= 0 || result > 10_000_000) {
    throw createError({ statusCode: 400, statusMessage: 'Укажите сумму' })
  }
  return Math.round(result * 100) / 100
}

function date(value: unknown, field: string) {
  const result = new Date(String(value ?? ''))
  if (Number.isNaN(result.getTime())) throw createError({ statusCode: 400, statusMessage: `Укажите корректную дату: ${field}` })
  return result
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ label?: unknown, kind?: unknown, amount?: unknown, startsAt?: unknown, endsAt?: unknown, note?: unknown }>(event)
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null
  if (!label) throw createError({ statusCode: 400, statusMessage: 'Укажите название расхода' })

  const startsAt = date(body?.startsAt, 'начало периода')
  // Период по умолчанию — год: страховка и налог покупаются именно так, и
  // спрашивать вторую дату ради того же самого незачем.
  const endsAt = body?.endsAt ? date(body.endsAt, 'конец периода') : new Date(startsAt.getTime() + YEAR_MS)
  if (endsAt <= startsAt) throw createError({ statusCode: 400, statusMessage: 'Период должен заканчиваться позже, чем начинается' })

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) throw createError({ statusCode: 404, statusMessage: 'Автомобиль не найден' })

  const [created] = await database.insert(fixedCosts).values({
    vehicleId: vehicle.id,
    kind: kind(body?.kind),
    label,
    amount: amount(body?.amount),
    startsAt,
    endsAt,
    note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null
  }).returning()
  return created
})
