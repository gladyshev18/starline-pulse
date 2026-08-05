import { and, asc, eq, lte, or } from 'drizzle-orm'
import type { Database } from '../db/client'
import { jobs } from '../db/schema'
import { notifyAllowedChats } from './bot'
import { buildReport, nextReportRun, type ReportPeriod } from './bot/reports'
import { aggregateSnapshot } from './starline/aggregates'
import { getDailyUsage } from './starline/budget'
import { pollVehicle } from './starline/poll'
import { closeTrip, handleMileageProgress, reconcileTripsWithEngineSessions } from './starline/trips'

const MAX_ATTEMPTS = 5
const REPORT_PERIODS: ReportPeriod[] = ['daily', 'weekly', 'monthly']

type ExecuteResult = { nextPollAt?: Date, nextReport?: ReportPeriod }

function parseJobPayload(value: string) {
  try {
    return JSON.parse(value || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function reportPeriod(value: unknown) {
  return typeof value === 'string' && REPORT_PERIODS.includes(value as ReportPeriod) ? value as ReportPeriod : null
}

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

async function scheduleReport(database: Database, period: ReportPeriod, now = new Date()) {
  const payload = JSON.stringify({ period })
  const existing = await database.query.jobs.findFirst({
    where: and(eq(jobs.type, 'telegram:report'), eq(jobs.payload, payload), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')))
  })
  if (!existing) await database.insert(jobs).values({ type: 'telegram:report', payload, runAt: nextReportRun(period, now) })
}

async function execute(database: Database, job: typeof jobs.$inferSelect): Promise<ExecuteResult> {
  const payload = parseJobPayload(job.payload)
  if (job.type === 'starline:poll') {
    const usage = await getDailyUsage(database)
    if (usage.remaining <= 100) {
      await notifyAllowedChats('Лимит StarLine API: резерв 100 запросов достигнут. Опрос остановлен до полуночи UTC.')
      const tomorrow = new Date(); tomorrow.setUTCHours(24, 1, 0, 0)
      return { nextPollAt: tomorrow }
    }
    const result = await pollVehicle(database)
    await aggregateSnapshot(database, result.vehicle.id, result.snapshot, result.previous)
    await handleMileageProgress(database, result.vehicle.id, result.snapshot, result.previous)
    return { nextPollAt: new Date(Date.now() + result.delayMs) }
  }
  if (job.type === 'starline:close_trip') {
    const vehicleId = Number(payload.vehicleId)
    const tripId = Number(payload.tripId)
    if (!Number.isInteger(vehicleId) || !Number.isInteger(tripId)) throw new Error('INVALID_CLOSE_TRIP_PAYLOAD')
    await closeTrip(database, { vehicleId, tripId })
  }
  if (job.type === 'telegram:notify') await notifyAllowedChats(String(payload.text || 'Уведомление'), payload.html === true)
  if (job.type === 'telegram:report') {
    const period = reportPeriod(payload.period)
    if (!period) throw new Error('UNKNOWN_TELEGRAM_REPORT_PERIOD')
    await notifyAllowedChats(await buildReport(database, period), true)
    return { nextReport: period }
  }
  return {}
}

export async function processNextJob(database: Database) {
  const job = await claim(database)
  if (!job) return false
  try {
    const result = await execute(database, job)
    await database.update(jobs).set({ status: 'done', updatedAt: new Date(), lastError: null }).where(eq(jobs.id, job.id))
    if (result.nextPollAt) await schedulePoll(database, result.nextPollAt.getTime() - Date.now())
    if (result.nextReport) {
      try {
        await scheduleReport(database, result.nextReport)
      } catch (error) {
        // The completed report must not be retried (and sent twice) only because
        // planning the next one failed. Queue initialization restores it on restart.
        console.error(`Scheduling the next ${result.nextReport} Telegram report failed`, error)
      }
    }
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
    const failedReportPeriod = job.type === 'telegram:report' ? reportPeriod(parseJobPayload(job.payload).period) : null
    if (failed && failedReportPeriod) {
      await scheduleReport(database, failedReportPeriod)
    }
    console.error(`Job ${job.id} (${job.type}) failed`, error)
  }
  return true
}

export async function initializeQueue(database: Database) {
  await database.update(jobs).set({ status: 'pending', updatedAt: new Date() }).where(eq(jobs.status, 'running'))
  await reconcileTripsWithEngineSessions(database)
  const poll = await database.query.jobs.findFirst({ where: and(eq(jobs.type, 'starline:poll'), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running'))) })
  if (!poll) await database.insert(jobs).values({ type: 'starline:poll', payload: '{}' })
  for (const period of REPORT_PERIODS) await scheduleReport(database, period)
}
