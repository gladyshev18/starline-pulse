import { createDatabase } from '../../db/client'

let database: ReturnType<typeof createDatabase> | undefined

export function useAppDatabase() {
  // Nuxt runtimeConfig defaults are baked into the server bundle. Prefer the
  // process environment so DATABASE_URL can be changed when the image starts.
  if (!database) database = createDatabase(process.env.DATABASE_URL || useRuntimeConfig().databaseUrl)
  return database
}
