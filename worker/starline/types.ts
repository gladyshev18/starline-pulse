export interface StarLineDeviceData {
  alias: string
  device_id: string | number
  activity_ts: number
  ts_activity?: number
  position?: { x?: number | string | null, y?: number | string | null, ts?: number }
  common?: { gsm_lvl?: number | null, battery?: number | null, ctemp?: number | null, etemp?: number | null, ts?: number }
  obd?: { fuel_litres?: number | null, fuel_percent?: number | null, mileage?: number | null, ts?: number }
  state?: { ign?: boolean | null, run?: boolean | null, ts?: number }
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
  ignition: boolean | null
  mileage: number | null
  fuel: number | null
  battery: number | null
  engineTemp: number | null
  cabinTemp: number | null
  lat: number | null
  lon: number | null
  gsmLevel: number | null
  rawJson: string
}
