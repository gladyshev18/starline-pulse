import 'dotenv/config'
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { createDatabase } from '../db/client'
import { users } from '../db/schema'

const database = createDatabase()
const seeds = [1, 2].map(index => ({
  login: process.env[`SEED_USER_${index}_LOGIN`]?.trim().toLowerCase(),
  password: process.env[`SEED_USER_${index}_PASSWORD`],
  displayName: process.env[`SEED_USER_${index}_DISPLAY_NAME`],
  telegramChatId: process.env[`SEED_USER_${index}_TELEGRAM_CHAT_ID`] || null
}))

for (const seed of seeds) {
  if (!seed.login || !seed.password || !seed.displayName) {
    throw new Error('Set login, password and display name for both seed users in .env')
  }
  const passwordHash = await argon2.hash(seed.password, { type: argon2.argon2id })
  const existing = await database.query.users.findFirst({ where: eq(users.login, seed.login) })
  if (existing) {
    await database.update(users).set({ passwordHash, displayName: seed.displayName, telegramChatId: seed.telegramChatId }).where(eq(users.id, existing.id))
  } else {
    await database.insert(users).values({ login: seed.login, passwordHash, displayName: seed.displayName, telegramChatId: seed.telegramChatId })
  }
  console.log(`Seeded ${seed.login}`)
}
