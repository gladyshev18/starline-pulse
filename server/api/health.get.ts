import { sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  await useAppDatabase().run(sql`select 1`)
  return { status: 'ok' }
})
