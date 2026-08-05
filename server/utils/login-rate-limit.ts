import type { H3Event } from 'h3'

const WINDOW_MS = 15 * 60 * 1000
const LIMIT = 5
const attempts = new Map<string, number[]>()

export function assertLoginRateLimit(event: H3Event) {
  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  const cutoff = Date.now() - WINDOW_MS
  const recent = (attempts.get(ip) || []).filter(timestamp => timestamp > cutoff)
  attempts.set(ip, recent)
  if (recent.length >= LIMIT) {
    throw createError({ statusCode: 429, statusMessage: 'Слишком много попыток. Повторите через 15 минут.' })
  }
  return () => attempts.set(ip, [...recent, Date.now()])
}
