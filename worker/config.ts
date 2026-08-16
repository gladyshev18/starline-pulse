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

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function senderAllowlist(value: string | undefined) {
  return (value || '').split(',').map(entry => entry.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
}

function receiptsMailMode(): 'off' | 'fixture' | 'live' {
  const mode = process.env.RECEIPTS_MAIL_MODE?.trim().toLowerCase()
  if (mode === 'fixture') return 'fixture'
  // Live import stays off until the mailbox is actually configured, so a partial
  // deployment cannot spin a failing job every quarter of an hour.
  if (mode === 'live' && process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD) return 'live'
  return 'off'
}

export const receiptsMailConfig = {
  mode: receiptsMailMode(),
  fixturePath: pathFromRoot(process.env.RECEIPTS_MAIL_FIXTURE_PATH || './fixtures/receipt-mail.example.json'),
  host: process.env.IMAP_HOST || '',
  port: positiveNumber(process.env.IMAP_PORT, 993),
  secure: process.env.IMAP_SECURE !== 'false',
  user: process.env.IMAP_USER || '',
  password: process.env.IMAP_PASSWORD || '',
  mailbox: process.env.IMAP_MAILBOX || 'INBOX',
  senderAllowlist: senderAllowlist(process.env.IMAP_SENDER_ALLOWLIST),
  sinceDays: positiveNumber(process.env.IMAP_SINCE_DAYS, 14),
  maxMessages: positiveNumber(process.env.IMAP_MAX_MESSAGES, 25),
  pollMinutes: positiveNumber(process.env.IMAP_POLL_MINUTES, 15),
  proxyUrl: process.env.IMAP_PROXY_URL || '',
  markSeen: process.env.IMAP_MARK_SEEN === 'true'
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
