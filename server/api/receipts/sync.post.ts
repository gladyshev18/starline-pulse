import { and, eq, or } from 'drizzle-orm'
import { jobs } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const database = useAppDatabase()
  const existing = await database.query.jobs.findFirst({
    where: and(eq(jobs.type, 'receipts:imap_poll'), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')))
  })

  // The worker owns the mailbox connection; the page only moves the next run up.
  if (existing) {
    if (existing.status === 'pending' && existing.runAt > new Date()) {
      await database.update(jobs).set({ runAt: new Date(), updatedAt: new Date() }).where(eq(jobs.id, existing.id))
    }
    setResponseStatus(event, 202)
    return { queued: true, jobId: existing.id }
  }

  const [created] = await database.insert(jobs).values({ type: 'receipts:imap_poll', payload: '{}' }).returning()
  setResponseStatus(event, 202)
  return { queued: true, jobId: created?.id ?? null }
})
