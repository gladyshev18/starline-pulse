import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { apiCalls } from '../../db/schema'

export async function getDailyUsage(database: Database) {
  const day = new Date().toISOString().slice(0, 10)
  const [row] = await database.select({ used: sql<number>`count(*)` }).from(apiCalls).where(eq(apiCalls.day, day))
  const used = Number(row?.used || 0)
  return { day, used, remaining: 1000 - used }
}

export async function assertBudget(database: Database) {
  const usage = await getDailyUsage(database)
  if (usage.remaining <= 100) throw new Error('STARLINE_DAILY_RESERVE_REACHED')
  return usage
}

export async function recordCall(database: Database, endpoint: string, status: number) {
  await database.insert(apiCalls).values({ day: new Date().toISOString().slice(0, 10), endpoint, status })
}
