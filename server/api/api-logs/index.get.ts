import { and, count, desc, eq, gte, like, lt, or, type SQL } from 'drizzle-orm'
import { apiCalls } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const page = Math.max(1, Number.parseInt(String(query.page || '1'), 10) || 1)
  const pageSize = 25
  const search = String(query.search || '').trim().slice(0, 120)
  const status = String(query.status || 'all')
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(query.day || '')) ? String(query.day) : ''
  const conditions: SQL[] = []

  if (search) conditions.push(or(like(apiCalls.endpoint, `%${search}%`), like(apiCalls.url, `%${search}%`))!)
  if (day) conditions.push(eq(apiCalls.day, day))
  if (status === 'success') conditions.push(and(gte(apiCalls.status, 200), lt(apiCalls.status, 400))!)
  if (status === 'error') conditions.push(or(eq(apiCalls.status, 0), gte(apiCalls.status, 400))!)

  const where = conditions.length ? and(...conditions) : undefined
  const database = useAppDatabase()
  const [result] = await database.select({ total: count() }).from(apiCalls).where(where)
  const items = await database.select({
    id: apiCalls.id,
    method: apiCalls.method,
    endpoint: apiCalls.endpoint,
    status: apiCalls.status,
    durationMs: apiCalls.durationMs,
    error: apiCalls.error,
    createdAt: apiCalls.createdAt
  }).from(apiCalls).where(where).orderBy(desc(apiCalls.createdAt)).limit(pageSize).offset((page - 1) * pageSize)

  const total = Number(result?.total || 0)
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize) }
})
