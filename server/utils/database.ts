import { createDatabase } from '../../db/client'

let database: ReturnType<typeof createDatabase> | undefined

export function useAppDatabase() {
  if (!database) database = createDatabase(useRuntimeConfig().databaseUrl)
  return database
}
