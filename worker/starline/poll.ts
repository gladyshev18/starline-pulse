import { readFile } from 'node:fs/promises'
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { vehicleSnapshots, vehicles } from '../../db/schema'
import { fuelFromPercent } from '../../shared/fuel'
import { config } from '../config'
import { getDailyUsage } from './budget'
import { getSlnet, starlineRequest } from './auth'
import type { NormalizedSnapshot, StarLineDataResponse, StarLineDeviceData } from './types'

function finite(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

function timestamp(value: unknown): Date | null {
  const seconds = finite(value)
  return seconds && seconds > 0 ? new Date(seconds * 1000) : null
}

function diagnosticJson(raw: StarLineDataResponse) {
  const data = raw.data
  if (!data) return JSON.stringify({ code: raw.code, codestring: raw.codestring })
  const position = data.position && {
    dir: data.position.dir,
    s: data.position.s,
    sat_qty: data.position.sat_qty,
    ts: data.position.ts,
    r: data.position.r,
    rpm: data.position.rpm,
    is_move: data.position.is_move
  }
  return JSON.stringify({
    code: raw.code,
    codestring: raw.codestring,
    data: {
      type: data.type,
      status: data.status,
      activity_ts: data.activity_ts ?? data.ts_activity,
      firmware_version: data.firmware_version,
      functions: data.functions,
      battery_type: data.battery_type,
      position,
      common: data.common,
      obd: data.obd,
      state: data.state,
      alarm_state: data.alarm_state,
      event: data.event,
      r_start: data.r_start,
      sys_extra_state: data.sys_extra_state,
      electric_status: data.electric_status
    }
  })
}

export function normalizeDeviceResponse(raw: StarLineDataResponse): NormalizedSnapshot {
  if (raw.code !== 200 || !raw.data) throw new Error(`StarLine data: ${raw.codestring || raw.code}`)
  const data: StarLineDeviceData = raw.data
  const ignition = typeof data.state?.ign === 'boolean' ? data.state.ign : typeof data.state?.run === 'boolean' ? data.state.run : null
  const fuelLitres = finite(data.obd?.fuel_litres)
  const fuelPercent = finite(data.obd?.fuel_percent)
  const fuelByPercent = fuelFromPercent(fuelPercent)
  const fuelConverted = finite(data.obd?.fuel_converted)
  const batteryType = data.common?.battery_type ?? data.battery_type
  return {
    deviceId: String(data.device_id), alias: data.alias || 'Chery', ts: new Date(), activityTs: timestamp(data.activity_ts ?? data.ts_activity),
    online: data.status === 1 ? true : data.status === 2 ? false : null,
    ignition, armed: typeof data.state?.arm === 'boolean' ? data.state.arm : null,
    mileage: finite(data.obd?.mileage), mileageTs: timestamp(data.obd?.mileage_ts ?? data.obd?.ts),
    fuel: fuelLitres ?? fuelByPercent ?? fuelConverted, fuelPercent, fuelTs: timestamp(data.obd?.fuel_ts ?? data.obd?.ts),
    fuelSource: fuelLitres != null ? 'litres' : fuelByPercent != null ? 'percent' : fuelConverted != null ? 'converted' : null,
    battery: finite(data.common?.battery), batteryType: batteryType === 'volt' || batteryType === 'percent' ? batteryType : null,
    commonTs: timestamp(data.common?.ts), engineTemp: finite(data.common?.etemp), cabinTemp: finite(data.common?.ctemp),
    lat: finite(data.position?.y), lon: finite(data.position?.x), positionTs: timestamp(data.position?.ts),
    gsmLevel: finite(data.common?.gsm_lvl), rawJson: diagnosticJson(raw)
  }
}

export async function readLoggedDeviceResponse(response: Response): Promise<StarLineDataResponse> {
  const rawBody = await response.text()
  const contentType = response.headers.get('content-type') || 'unknown'
  console.info(`[starline.api] status=${response.status} content-type=${contentType} body-bytes=${Buffer.byteLength(rawBody)}`)
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
    vehicleId: vehicle.id, ts: normalized.ts, activityTs: normalized.activityTs, online: normalized.online,
    ignition: normalized.ignition, armed: normalized.armed, mileage: normalized.mileage, mileageTs: normalized.mileageTs,
    fuel: normalized.fuel, fuelPercent: normalized.fuelPercent, fuelTs: normalized.fuelTs, fuelSource: normalized.fuelSource,
    battery: normalized.battery, batteryType: normalized.batteryType, commonTs: normalized.commonTs,
    engineTemp: normalized.engineTemp, cabinTemp: normalized.cabinTemp, lat: normalized.lat, lon: normalized.lon,
    positionTs: normalized.positionTs, gsmLevel: normalized.gsmLevel, rawJson: normalized.rawJson
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
