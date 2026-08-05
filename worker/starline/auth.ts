import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { starlineTokens } from '../../db/schema'
import { config } from '../config'
import { assertBudget, recordCall } from './budget'

type TokenKind = 'app_code' | 'app_token' | 'user_token' | 'slnet'
let refreshPromise: Promise<string> | null = null

function digest(algorithm: 'md5' | 'sha1', value: string) {
  return createHash(algorithm).update(value).digest('hex')
}

async function request(database: Database, url: string, init?: RequestInit) {
  await assertBudget(database)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    await recordCall(database, new URL(url).pathname, 0)
    throw error
  }
  await recordCall(database, new URL(url).pathname, response.status)
  return response
}

async function cached(database: Database, kind: TokenKind) {
  const token = await database.query.starlineTokens.findFirst({ where: eq(starlineTokens.kind, kind) })
  if (!token) return null
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now() + 60_000) return null
  return token.value
}

async function save(database: Database, kind: TokenKind, value: string, ttlMs?: number) {
  await database.insert(starlineTokens).values({ kind, value, expiresAt: ttlMs ? new Date(Date.now() + ttlMs) : null })
    .onConflictDoUpdate({ target: starlineTokens.kind, set: { value, expiresAt: ttlMs ? new Date(Date.now() + ttlMs) : null, updatedAt: new Date() } })
  return value
}

async function getAppCode(database: Database) {
  const existing = await cached(database, 'app_code')
  if (existing) return existing
  const url = new URL('https://id.starline.ru/apiV3/application/getCode')
  url.searchParams.set('appId', config.starlineAppId)
  url.searchParams.set('secret', digest('md5', config.starlineAppSecret))
  const payload = await (await request(database, url.toString())).json() as any
  if (payload.state !== 1 || !payload.desc?.code) throw new Error(`StarLine getCode: ${payload.desc?.message || 'unknown error'}`)
  return save(database, 'app_code', payload.desc.code, 60 * 60 * 1000)
}

async function getAppToken(database: Database) {
  const existing = await cached(database, 'app_token')
  if (existing) return existing
  const code = await getAppCode(database)
  const url = new URL('https://id.starline.ru/apiV3/application/getToken')
  url.searchParams.set('appId', config.starlineAppId)
  url.searchParams.set('secret', digest('md5', config.starlineAppSecret + code))
  const payload = await (await request(database, url.toString())).json() as any
  if (payload.state !== 1 || !payload.desc?.token) throw new Error(`StarLine getToken: ${payload.desc?.message || 'unknown error'}`)
  return save(database, 'app_token', payload.desc.token, 4 * 60 * 60 * 1000)
}

async function getUserToken(database: Database) {
  const existing = await cached(database, 'user_token')
  if (existing) return existing
  const appToken = await getAppToken(database)
  const body = new URLSearchParams({ login: config.starlineLogin, pass: digest('sha1', config.starlinePassword) })
  const response = await request(database, 'https://id.starline.ru/apiV3/user/login', { method: 'POST', headers: { token: appToken, 'content-type': 'application/x-www-form-urlencoded' }, body })
  const payload = await response.json() as any
  if (payload.state !== 1 || !payload.desc?.user_token) throw new Error(`StarLine user login: ${payload.desc?.message || 'unknown error'}`)
  return save(database, 'user_token', payload.desc.user_token)
}

async function refreshSlnet(database: Database) {
  if (!config.starlineAppId || !config.starlineAppSecret || !config.starlineLogin || !config.starlinePassword) throw new Error('StarLine live credentials are incomplete')
  const userToken = await getUserToken(database)
  const response = await request(database, 'https://developer.starline.ru/json/v2/auth.slid', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slid_token: userToken })
  })
  const payload = await response.json() as any
  if (payload.code !== 200) {
    await database.delete(starlineTokens).where(eq(starlineTokens.kind, 'user_token'))
    throw new Error(`StarLine slnet auth: ${payload.codestring || payload.code}`)
  }
  const cookie = response.headers.get('set-cookie') || ''
  const token = /(?:^|;\s*)slnet=([^;]+)/i.exec(cookie)?.[1]
  if (!token) throw new Error('StarLine slnet cookie missing in response')
  return save(database, 'slnet', token, 24 * 60 * 60 * 1000)
}

export async function getSlnet(database: Database) {
  const existing = await cached(database, 'slnet')
  if (existing) return existing
  if (!refreshPromise) refreshPromise = refreshSlnet(database).finally(() => { refreshPromise = null })
  return refreshPromise
}

export { request as starlineRequest }
