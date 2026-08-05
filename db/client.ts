import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema'

function normalizeUrl(url: string) {
  if (!url.startsWith('file:')) return url
  const value = url.slice(5)
  if (isAbsolute(value)) return `file:${value.replaceAll('\\', '/')}`
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const path = resolve(projectRoot, value)
  return `file:${path.replaceAll('\\', '/')}`
}

export function createDatabase(url = process.env.DATABASE_URL || 'file:./data/app.db') {
  const client = createClient({ url: normalizeUrl(url) })
  return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDatabase>
