import { jobs } from '../../db/schema'

export default defineEventHandler(async () => {
  await useAppDatabase().insert(jobs).values({ type: 'starline:poll', payload: JSON.stringify({ source: 'web' }) })
  return { queued: true }
})
