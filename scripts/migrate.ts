import 'dotenv/config'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { createDatabase } from '../db/client'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const databaseUrl = process.env.DATABASE_URL || `file:${resolve(root, 'data', 'app.db')}`
const databasePath = databaseUrl.startsWith('file:') ? databaseUrl.slice(5) : null
if (databasePath) await mkdir(dirname(resolve(root, databasePath)), { recursive: true })

await migrate(createDatabase(databaseUrl), { migrationsFolder: resolve(root, 'db', 'migrations') })
console.log('Database migrations applied')
