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

export function normalizeTelegramProxyUrl(value: string | null | undefined) {
  const candidate = value?.trim()
  if (!candidate) return ''
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('TELEGRAM_PROXY_URL must be a valid proxy URL')
  }
  if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname) {
    throw new Error('TELEGRAM_PROXY_URL must use http, https, socks, socks5 or socks5h protocol')
  }
  return url.protocol === 'socks5h:' ? candidate.replace(/^socks5h:/i, 'socks5:') : candidate
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
  telegramProxyUrl: normalizeTelegramProxyUrl(process.env.TELEGRAM_PROXY_URL),
  telegramAllowedUsernames: telegramUsernames(process.env.TELEGRAM_ALLOWED_USERNAMES)
}
