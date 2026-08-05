import { readFile } from 'node:fs/promises'
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { vehicleSnapshots, vehicles } from '../../db/schema'
import { config } from '../config'
import { getDailyUsage } from './budget'
import { getSlnet, starlineRequest } from './auth'
import type { NormalizedSnapshot, StarLineDataResponse, StarLineDeviceData } from './types'

function finite(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

export function normalizeDeviceResponse(raw: StarLineDataResponse): NormalizedSnapshot {
  if (raw.code !== 200 || !raw.data) throw new Error(`StarLine data: ${raw.codestring || raw.code}`)
  const data: StarLineDeviceData = raw.data
  const activity = finite(data.activity_ts ?? data.ts_activity)
  const ignition = typeof data.state?.ign === 'boolean' ? data.state.ign : typeof data.state?.run === 'boolean' ? data.state.run : null
  return {
    deviceId: String(data.device_id), alias: data.alias || 'Chery', ts: new Date(), activityTs: activity ? new Date(activity * 1000) : null,
    ignition, mileage: finite(data.obd?.mileage), fuel: finite(data.obd?.fuel_litres), battery: finite(data.common?.battery),
    engineTemp: finite(data.common?.etemp), cabinTemp: finite(data.common?.ctemp), lat: finite(data.position?.x), lon: finite(data.position?.y),
    gsmLevel: finite(data.common?.gsm_lvl), rawJson: JSON.stringify(raw)
  }
}

export async function readLoggedDeviceResponse(response: Response): Promise<StarLineDataResponse> {
  const rawBody = await response.text()
  const contentType = response.headers.get('content-type') || 'unknown'
  console.info(`[starline.api.raw] status=${response.status} content-type=${contentType} body=${rawBody}`)
  return JSON.parse(rawBody) as StarLineDataResponse
}

async function readRaw(database: Database) {
  if (config.starlineMode === 'fixture') return JSON.parse(await readFile(config.starlineFixturePath, 'utf8')) as StarLineDataResponse
  const slnet = await getSlnet(database)
  const response = await starlineRequest(database, `https://developer.starline.ru/json/v3/device/${encodeURIComponent(config.starlineDeviceId)}/data`, { headers: { cookie: `slnet=${slnet}` } })
  return await readLoggedDeviceResponse(response)
}

export async function pollVehicle(database: Database) {
  const normalized = normalizeDeviceResponse(await readRaw(database))
  await database.insert(vehicles).values({ deviceId: normalized.deviceId, alias: normalized.alias })
    .onConflictDoUpdate({ target: vehicles.deviceId, set: { alias: normalized.alias } })
  const vehicle = await database.query.vehicles.findFirst({ where: eq(vehicles.deviceId, normalized.deviceId) })
  if (!vehicle) throw new Error('Vehicle upsert failed')
  const previous = await database.query.vehicleSnapshots.findFirst({ where: eq(vehicleSnapshots.vehicleId, vehicle.id), orderBy: desc(vehicleSnapshots.ts) })

  if (previous?.mileage != null && normalized.mileage != null && normalized.mileage < previous.mileage) {
    throw new Error(`Rejected decreasing mileage: ${normalized.mileage} < ${previous.mileage}`)
  }
  const [snapshot] = await database.insert(vehicleSnapshots).values({
    vehicleId: vehicle.id, ts: normalized.ts, activityTs: normalized.activityTs, ignition: normalized.ignition, mileage: normalized.mileage,
    fuel: normalized.fuel, battery: normalized.battery, engineTemp: normalized.engineTemp, cabinTemp: normalized.cabinTemp,
    lat: normalized.lat, lon: normalized.lon, gsmLevel: normalized.gsmLevel, rawJson: normalized.rawJson
  }).returning()

  const usage = config.starlineMode === 'live' ? await getDailyUsage(database) : { remaining: 1000 }
  const stale = previous?.activityTs && normalized.activityTs && previous.activityTs.getTime() === normalized.activityTs.getTime()
  let delayMs: number
  if (normalized.ignition === true) delayMs = 30_000
  else if (previous?.ignition === true) delayMs = 2 * 60_000
  else {
    const hour = new Date().getHours()
    const lastIgnitionOn = await database.query.vehicleSnapshots.findFirst({
      where: and(eq(vehicleSnapshots.vehicleId, vehicle.id), eq(vehicleSnapshots.ignition, true)),
      orderBy: desc(vehicleSnapshots.ts)
    })
    const recentlyStopped = lastIgnitionOn && Date.now() - lastIgnitionOn.ts.getTime() <= 10 * 60_000
    delayMs = recentlyStopped ? 2 * 60_000 : hour >= 6 && hour < 23 ? 5 * 60_000 : 30 * 60_000
  }
  if (stale || usage.remaining < 200) delayMs *= 2
  return { vehicle, snapshot, previous, delayMs }
}
