import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { apiCalls } from '../../db/schema'

const MAX_LOG_VALUE_LENGTH = 256_000
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|pass|captcha(?:code)?|sms(?:code)?|login)/i

export interface ApiCallLog {
  url: string
  method: string
  status: number
  durationMs: number
  requestHeaders?: HeadersInit
  requestBody?: BodyInit | null
  responseHeaders?: HeadersInit
  responseBody?: string | null
  error?: string | null
}

function truncate(value: string | null) {
  if (value == null || value.length <= MAX_LOG_VALUE_LENGTH) return value
  return `${value.slice(0, MAX_LOG_VALUE_LENGTH)}\n… [обрезано, исходный размер: ${value.length} символов]`
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[СКРЫТО]' : redactValue(item)]))
  }
  return value
}

export function sanitizeUrl(value: string) {
  const url = new URL(value)
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[СКРЫТО]')
  }
  return url.toString()
}

export function sanitizeHeaders(headers?: HeadersInit) {
  if (!headers) return null
  const safe = Object.fromEntries([...new Headers(headers).entries()].map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? '[СКРЫТО]' : value]))
  return truncate(JSON.stringify(safe, null, 2))
}

export function sanitizeBody(body: string | null | undefined, contentType = '') {
  if (body == null || body === '') return body || null
  try {
    if (contentType.includes('json') || /^[\s]*[\[{]/.test(body)) {
      return truncate(JSON.stringify(redactValue(JSON.parse(body)), null, 2))
    }
    if (contentType.includes('x-www-form-urlencoded')) {
      const params = new URLSearchParams(body)
      for (const key of [...params.keys()]) if (SENSITIVE_KEY.test(key)) params.set(key, '[СКРЫТО]')
      return truncate(params.toString())
    }
  } catch {
    // Keep non-JSON upstream errors visible for diagnostics.
  }
  return truncate(body)
}

async function requestBodyText(body?: BodyInit | null) {
  if (body == null) return null
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Blob) return body.text()
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  if (body instanceof FormData) {
    const values: Record<string, string> = {}
    for (const [key, value] of body.entries()) values[key] = typeof value === 'string' ? value : `[Файл: ${value.name}, ${value.size} байт]`
    return JSON.stringify(values)
  }
  return '[Потоковое тело запроса]'
}

export async function getDailyUsage(database: Database) {
  const day = new Date().toISOString().slice(0, 10)
  const [row] = await database.select({ used: sql<number>`count(*)` }).from(apiCalls).where(eq(apiCalls.day, day))
  const used = Number(row?.used || 0)
  return { day, used, remaining: 1000 - used }
}

export async function assertBudget(database: Database) {
  const usage = await getDailyUsage(database)
  if (usage.remaining <= 100) throw new Error('STARLINE_DAILY_RESERVE_REACHED')
  return usage
}

export async function recordCall(database: Database, call: ApiCallLog) {
  const parsedUrl = new URL(call.url)
  const requestHeaders = new Headers(call.requestHeaders)
  const responseHeaders = new Headers(call.responseHeaders)
  const rawRequestBody = await requestBodyText(call.requestBody)
  await database.insert(apiCalls).values({
    day: new Date().toISOString().slice(0, 10),
    endpoint: parsedUrl.pathname,
    method: call.method,
    url: sanitizeUrl(call.url),
    status: call.status,
    durationMs: call.durationMs,
    requestHeaders: sanitizeHeaders(requestHeaders),
    requestBody: sanitizeBody(rawRequestBody, requestHeaders.get('content-type') || ''),
    responseHeaders: sanitizeHeaders(responseHeaders),
    responseBody: sanitizeBody(call.responseBody, responseHeaders.get('content-type') || ''),
    error: truncate(call.error || null)
  })
}
