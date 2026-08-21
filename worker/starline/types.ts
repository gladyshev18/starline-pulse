export interface StarLineDeviceData {
  alias: string
  type?: number
  status?: number
  device_id: string | number
  activity_ts: number
  ts_activity?: number
  firmware_version?: string
  functions?: string[]
  battery_type?: 'percent' | 'volt' | string
  position?: {
    x?: number | string | null
    y?: number | string | null
    ts?: number | null
    dir?: number | null
    s?: number | null
    sat_qty?: number | null
    r?: number | null
    rpm?: number | null
    is_move?: boolean | number | null
  }
  common?: {
    gsm_lvl?: number | null
    battery?: number | null
    battery_type?: 'percent' | 'volt' | string
    ctemp?: number | null
    etemp?: number | null
    ts?: number | null
    [key: string]: unknown
  }
  obd?: {
    fuel_litres?: number | null
    fuel_percent?: number | null
    fuel_converted?: number | null
    fuel_ts?: number | null
    mileage?: number | null
    mileage_ts?: number | null
    ts?: number | null
    [key: string]: unknown
  }
  state?: { ign?: boolean | null, run?: boolean | null, arm?: boolean | null, ts?: number, [key: string]: unknown }
  alarm_state?: Record<string, unknown>
  event?: unknown
  r_start?: Record<string, unknown>
  sys_extra_state?: Record<string, unknown>
  electric_status?: Record<string, unknown>
}

export interface StarLineDataResponse {
  data?: StarLineDeviceData
  code: number
  codestring?: string
}

export interface NormalizedSnapshot {
  deviceId: string
  alias: string
  ts: Date
  activityTs: Date | null
  online: boolean | null
  ignition: boolean | null
  armed: boolean | null
  mileage: number | null
  mileageTs: Date | null
  fuel: number | null
  fuelPercent: number | null
  fuelTs: Date | null
  fuelSource: 'litres' | 'percent' | 'converted' | null
  battery: number | null
  batteryType: 'percent' | 'volt' | null
  commonTs: Date | null
  engineTemp: number | null
  cabinTemp: number | null
  lat: number | null
  lon: number | null
  positionTs: Date | null
  gsmLevel: number | null
  rawJson: string
}
