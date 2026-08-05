import { and, asc, eq, lte, or } from 'drizzle-orm'
import type { Database } from '../db/client'
import { jobs } from '../db/schema'
import { notifyAllowedChats } from './bot'
import { getDailyUsage } from './starline/budget'
import { pollVehicle } from './starline/poll'
import { closeTrip, handleMileageProgress } from './starline/trips'

const MAX_ATTEMPTS = 5

async function claim(database: Database) {
  const job = await database.query.jobs.findFirst({ where: and(eq(jobs.status, 'pending'), lte(jobs.runAt, new Date())), orderBy: asc(jobs.runAt) })
  if (!job) return null
  const [claimed] = await database.update(jobs).set({ status: 'running', attempts: job.attempts + 1, updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'pending'))).returning()
  return claimed || null
}

async function schedulePoll(database: Database, delayMs: number) {
  const existing = await database.query.jobs.findFirst({ where: and(eq(jobs.type, 'starline:poll'), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running'))) })
  if (!existing) await database.insert(jobs).values({ type: 'starline:poll', payload: '{}', runAt: new Date(Date.now() + delayMs) })
}

async function execute(database: Database, job: typeof jobs.$inferSelect) {
  const payload = JSON.parse(job.payload || '{}')
  if (job.type === 'starline:poll') {
    const usage = await getDailyUsage(database)
    if (usage.remaining <= 100) {
      await notifyAllowedChats('Лимит StarLine API: резерв 100 запросов достигнут. Опрос остановлен до полуночи UTC.')
      const tomorrow = new Date(); tomorrow.setUTCHours(24, 1, 0, 0)
      return { nextPollAt: tomorrow }
    }
    const result = await pollVehicle(database)
    await handleMileageProgress(database, result.vehicle.id, result.snapshot, result.previous)
    return { nextPollAt: new Date(Date.now() + result.delayMs) }
  }
  if (job.type === 'starline:close_trip') await closeTrip(database, payload)
  if (job.type === 'telegram:notify') await notifyAllowedChats(String(payload.text || 'Уведомление'))
  return {}
}

export async function processNextJob(database: Database) {
  const job = await claim(database)
  if (!job) return false
  try {
    const result = await execute(database, job)
    await database.update(jobs).set({ status: 'done', updatedAt: new Date(), lastError: null }).where(eq(jobs.id, job.id))
    if (result.nextPollAt) await schedulePoll(database, result.nextPollAt.getTime() - Date.now())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = job.attempts >= MAX_ATTEMPTS
    await database.update(jobs).set({
      status: failed ? 'failed' : 'pending', lastError: message, updatedAt: new Date(),
      runAt: failed ? job.runAt : new Date(Date.now() + 2 ** job.attempts * 60_000)
    }).where(eq(jobs.id, job.id))
    if (failed && job.type !== 'telegram:notify') {
      await database.insert(jobs).values({ type: 'telegram:notify', payload: JSON.stringify({ text: `Задача ${job.type} #${job.id} завершилась ошибкой после ${MAX_ATTEMPTS} попыток: ${message}` }) })
    }
    console.error(`Job ${job.id} (${job.type}) failed`, error)
  }
  return true
}

export async function initializeQueue(database: Database) {
  await database.update(jobs).set({ status: 'pending', updatedAt: new Date() }).where(eq(jobs.status, 'running'))
  const poll = await database.query.jobs.findFirst({ where: and(eq(jobs.type, 'starline:poll'), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running'))) })
  if (!poll) await database.insert(jobs).values({ type: 'starline:poll', payload: '{}' })
}
