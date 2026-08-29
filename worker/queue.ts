import { and, asc, eq, lte, or } from 'drizzle-orm'
import type { Database } from '../db/client'
import { jobs, trips, vehicles } from '../db/schema'
import { ingestReceiptMail } from '../receipts/mail/ingest'
import { parseActDocument } from '../receipts/act-job'
import { notifyAllowedChats } from './bot'
import { buildFuelReminder, nextFuelReminderRun } from './bot/fuel-reminder'
import { buildReport, nextReportRun, type ReportPeriod } from './bot/reports'
import { config, receiptsMailConfig } from './config'
import { buildReceiptImportNotice } from './bot/receipt-notices'
import { buildDriverKeyboard } from './bot/trip-driver'
import { aggregateSnapshot } from './starline/aggregates'
import { getDailyUsage } from './starline/budget'
import { applyEventBoundaries, syncEvents } from './starline/events'
import { pollVehicle } from './starline/poll'
import { closeTrip, handleMileageProgress, reconcileTripsWithEngineSessions } from './starline/trips'

const MAX_ATTEMPTS = 5
// Журнал сигнализации меняется только когда машину заводят, поэтому чаще часа
// спрашивать нечего: страница на сотню событий покрывает сутки с запасом, а
// дневной лимит обращений к StarLine — тысяча на всё вместе с опросом.
const EVENTS_INTERVAL_MS = 60 * 60_000
const REPORT_PERIODS: ReportPeriod[] = ['daily', 'weekly', 'monthly']

type ExecuteResult = { nextPollAt?: Date, nextReport?: ReportPeriod, nextFuelReminder?: boolean, nextMailPoll?: boolean, nextEvents?: boolean }

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
  const runAt = nextReportRun(period, now)
  const existing = await database.query.jobs.findFirst({
    where: and(eq(jobs.type, 'telegram:report'), eq(jobs.payload, payload), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')))
  })
  if (!existing) {
    await database.insert(jobs).values({ type: 'telegram:report', payload, runAt })
  } else if (existing.status === 'pending' && existing.attempts === 0 && existing.runAt > now && existing.runAt.getTime() !== runAt.getTime()) {
    await database.update(jobs).set({ runAt, updatedAt: now }).where(eq(jobs.id, existing.id))
  }
}

async function scheduleFuelReminder(database: Database, now = new Date()) {
  const runAt = nextFuelReminderRun(now)
  const existing = await database.query.jobs.findFirst({
    where: and(eq(jobs.type, 'telegram:fuel_reminder'), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')))
  })
  if (!existing) await database.insert(jobs).values({
    type: 'telegram:fuel_reminder',
    payload: '{}',
    runAt
  })
  else if (existing.status === 'pending' && existing.attempts === 0 && existing.runAt > now && existing.runAt.getTime() !== runAt.getTime()) {
    await database.update(jobs).set({ runAt, updatedAt: now }).where(eq(jobs.id, existing.id))
  }
}

async function scheduleEvents(database: Database, delayMs = EVENTS_INTERVAL_MS) {
  if (config.starlineMode !== 'live') return
  const existing = await database.query.jobs.findFirst({
    where: and(eq(jobs.type, 'starline:events'), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')))
  })
  const runAt = new Date(Date.now() + delayMs)
  if (!existing) {
    await database.insert(jobs).values({ type: 'starline:events', payload: '{}', runAt })
    return
  }
  // Закрытие поездки просит уточнить границы прямо сейчас, а в очереди уже
  // висит плановый заход через час. Двигать его вперёд дешевле, чем заводить
  // второй такой же.
  if (existing.status === 'pending' && existing.runAt > runAt) {
    await database.update(jobs).set({ runAt, updatedAt: new Date() }).where(eq(jobs.id, existing.id))
  }
}

async function scheduleMailPoll(database: Database, delayMs = receiptsMailConfig.pollMinutes * 60_000) {
  if (receiptsMailConfig.mode === 'off') return
  const existing = await database.query.jobs.findFirst({
    where: and(eq(jobs.type, 'receipts:imap_poll'), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')))
  })
  if (!existing) await database.insert(jobs).values({ type: 'receipts:imap_poll', payload: '{}', runAt: new Date(Date.now() + delayMs) })
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
    // Поездка только что закрылась опросом, который видит машину раз в
    // полминуты. Журнал сигнализации знает её границы с точностью до секунды —
    // самое время их уточнить, пока запись свежая.
    await scheduleEvents(database, 0)
  }
  if (job.type === 'starline:events') {
    if (config.starlineMode !== 'live') return { nextEvents: true }
    const vehicle = await database.query.vehicles.findFirst({ where: eq(vehicles.deviceId, config.starlineDeviceId) })
    if (!vehicle) return { nextEvents: true }
    const stored = await syncEvents(database, vehicle.id)
    if (stored) {
      const report = await applyEventBoundaries(database, vehicle.id, new Date(Date.now() - EVENTS_INTERVAL_MS * 24))
      if (report.corrected.length || report.created.length || report.removed.length) {
        console.info(`[starline.events] уточнено сессий: ${report.corrected.length}, заведено пропущенных: ${report.created.length}, снято прогревов: ${report.removed.length}`)
      }
    }
    return { nextEvents: true }
  }
  if (job.type === 'telegram:notify') {
    // Клавиатура строится в момент отправки, а не при постановке задачи: между
    // ними мог смениться список тех, кто вообще получает уведомления.
    const tripId = Number(payload.tripId)
    // Время начала нужно, чтобы предложить того, кто обычно ездит в этот час
    // этого дня недели, — иначе на вопрос отвечают вдвое реже, чем спрашивают.
    const trip = Number.isInteger(tripId) && tripId > 0
      ? await database.query.trips.findFirst({ where: eq(trips.id, tripId) })
      : null
    const keyboard = trip ? await buildDriverKeyboard(database, trip.id, trip.startedAt) : null
    await notifyAllowedChats(String(payload.text || 'Уведомление'), { html: payload.html === true, keyboard: keyboard || undefined })
  }
  if (job.type === 'telegram:report') {
    const period = reportPeriod(payload.period)
    if (!period) throw new Error('UNKNOWN_TELEGRAM_REPORT_PERIOD')
    await notifyAllowedChats(await buildReport(database, period), { html: true })
    return { nextReport: period }
  }
  if (job.type === 'telegram:fuel_reminder') {
    const reminder = await buildFuelReminder(database)
    if (reminder) await notifyAllowedChats(reminder, { html: true, sound: true })
    return { nextFuelReminder: true }
  }
  if (job.type === 'service:parse_act') {
    const documentId = Number(payload.documentId)
    if (!Number.isInteger(documentId)) throw new Error('INVALID_PARSE_ACT_PAYLOAD')
    await parseActDocument(database, documentId)
  }
  if (job.type === 'receipts:imap_poll') {
    const summary = await ingestReceiptMail(database, receiptsMailConfig)
    const notice = buildReceiptImportNotice(summary)
    if (notice) await notifyAllowedChats(notice, { html: true })
    return { nextMailPoll: true }
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
    if (result.nextFuelReminder) await scheduleFuelReminder(database)
    if (result.nextMailPoll) await scheduleMailPoll(database)
    if (result.nextEvents) await scheduleEvents(database)
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
    if (failed && job.type === 'telegram:fuel_reminder') await scheduleFuelReminder(database)
    if (failed && job.type === 'receipts:imap_poll') await scheduleMailPoll(database)
    if (failed && job.type === 'starline:events') await scheduleEvents(database)
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
  await scheduleFuelReminder(database)
  await scheduleMailPoll(database, 0)
  await scheduleEvents(database, 0)
}
