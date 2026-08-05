import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { isAbsolute, resolve } from 'node:path'
import * as schema from './schema'

function normalizeUrl(url: string) {
  if (!url.startsWith('file:')) return url
  const value = url.slice(5)
  if (isAbsolute(value)) return `file:${value.replaceAll('\\', '/')}`
  // import.meta.url points inside .output after bundling. The application and
  // worker both start from the project root, so relative database URLs must be
  // anchored to the process working directory instead.
  const path = resolve(value)
  return `file:${path.replaceAll('\\', '/')}`
}

export function createDatabase(url = process.env.DATABASE_URL || 'file:./data/app.db') {
  const client = createClient({ url: normalizeUrl(url) })
  return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDatabase>
