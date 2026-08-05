import 'dotenv/config'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function pathFromRoot(value: string) {
  if (isAbsolute(value)) return value
  return resolve(projectRoot, value.split(/[\\/]/).join(sep))
}

export function normalizeTelegramUsername(value: string | null | undefined) {
  const username = value?.trim().replace(/^@/, '').toLowerCase()
  return username && /^[a-z0-9_]{5,32}$/.test(username) ? `@${username}` : null
}

function telegramUsernames(value: string | undefined) {
  return new Set((value || '').split(',').map(normalizeTelegramUsername).filter((username): username is string => Boolean(username)))
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || `file:${resolve(projectRoot, 'data', 'app.db')}`,
  starlineMode: process.env.STARLINE_MODE === 'live' ? 'live' as const : 'fixture' as const,
  starlineFixturePath: pathFromRoot(process.env.STARLINE_FIXTURE_PATH || './fixtures/starline-device.example.json'),
  starlineAppId: process.env.STARLINE_APP_ID || '',
  starlineAppSecret: process.env.STARLINE_APP_SECRET || '',
  starlineLogin: process.env.STARLINE_LOGIN || '',
  starlinePassword: process.env.STARLINE_PASSWORD || '',
  starlineDeviceId: process.env.STARLINE_DEVICE_ID || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowedUsernames: telegramUsernames(process.env.TELEGRAM_ALLOWED_USERNAMES)
}
