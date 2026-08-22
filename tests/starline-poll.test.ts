import { describe, expect, it, vi } from 'vitest'
import { normalizeDeviceResponse, readLoggedDeviceResponse } from '../worker/starline/poll'

describe('normalizeDeviceResponse', () => {
  it('extracts the complete vehicle snapshot from one response', () => {
    const result = normalizeDeviceResponse({ code: 200, data: {
      alias: 'Автомобиль', device_id: 42, activity_ts: 1_700_000_000,
      status: 1, position: { x: 37.6, y: 55.7 }, common: { battery: 12.4, battery_type: 'volt', ctemp: 22, etemp: 70, gsm_lvl: 19 },
      obd: { mileage: 1234.5, fuel_litres: 31.2, fuel_percent: 62 }, state: { ign: true, arm: false }
    } })
    expect(result).toMatchObject({
      deviceId: '42', alias: 'Автомобиль', online: true, ignition: true, armed: false, mileage: 1234.5,
      fuel: 31.2, fuelPercent: 62, fuelSource: 'litres', battery: 12.4, batteryType: 'volt', lat: 55.7, lon: 37.6
    })
  })

  // Armed with the engine running is the one unambiguous warm-up, so the flag has
  // to survive the trip from the response into the snapshot.
  it('keeps the alarm state, and does not invent one when it is missing', () => {
    const base = { alias: 'Автомобиль', device_id: 42, activity_ts: 1_700_000_000, obd: {} }
    expect(normalizeDeviceResponse({ code: 200, data: { ...base, state: { ign: true, arm: true } } }).armed).toBe(true)
    expect(normalizeDeviceResponse({ code: 200, data: { ...base, state: { ign: true } } }).armed).toBeNull()
    expect(normalizeDeviceResponse({ code: 200, data: { ...base, state: { ign: true, arm: null } } }).armed).toBeNull()
  })

  it('converts the percentage itself instead of trusting the API-floored litres', () => {
    const result = normalizeDeviceResponse({ code: 200, data: {
      alias: 'Автомобиль', device_id: 42, activity_ts: 1_700_000_000,
      obd: { mileage: 1234, fuel_litres: null, fuel_percent: 77, fuel_converted: 38 }, state: { ign: false }
    } })
    expect(result).toMatchObject({ fuel: 38.5, fuelPercent: 77, fuelSource: 'percent' })
  })

  it('falls back to the API-converted fuel value when the percentage is absent', () => {
    const result = normalizeDeviceResponse({ code: 200, data: {
      alias: 'Автомобиль', device_id: 42, activity_ts: 1_700_000_000,
      obd: { mileage: 1234, fuel_litres: null, fuel_percent: null, fuel_converted: 37 }, state: { ign: false }
    } })
    expect(result).toMatchObject({ fuel: 37, fuelPercent: null, fuelSource: 'converted' })
  })

  it('keeps personally identifying data and exact coordinates out of diagnostic JSON', () => {
    const result = normalizeDeviceResponse({ code: 200, data: {
      alias: 'Personal car', device_id: 42, activity_ts: 1_700_000_000,
      position: { x: 37.6, y: 55.7 }, obd: {}, state: { ign: false }
    } })
    expect(result.rawJson).not.toContain('Personal car')
    expect(result.rawJson).not.toContain('37.6')
    expect(result.rawJson).not.toContain('55.7')
    expect(result.rawJson).not.toContain('"device_id"')
  })

  it('preserves unavailable OBD values as null', () => {
    const result = normalizeDeviceResponse({ code: 200, data: { alias: 'Автомобиль', device_id: 42, activity_ts: 1, obd: {}, state: { ign: false } } })
    expect(result.mileage).toBeNull()
    expect(result.fuel).toBeNull()
  })

  it('rejects an API error response', () => {
    expect(() => normalizeDeviceResponse({ code: 401, codestring: 'Unauthorized' })).toThrow('Unauthorized')
  })
})

describe('readLoggedDeviceResponse', () => {
  it('logs the untouched API body before parsing it', async () => {
    const rawBody = '{"code":200,"data":{"device_id":42}}'
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expect(readLoggedDeviceResponse(new Response(rawBody, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))).resolves.toEqual({ code: 200, data: { device_id: 42 } })
      expect(info).toHaveBeenCalledWith('[starline.api] status=200 content-type=application/json body-bytes=36')
    } finally {
      info.mockRestore()
    }
  })

  it('logs an invalid API body before JSON parsing fails', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expect(readLoggedDeviceResponse(new Response('upstream error', { status: 502 }))).rejects.toThrow()
      expect(info).toHaveBeenCalledWith(expect.stringContaining('status=502'))
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('upstream error'))
    } finally {
      info.mockRestore()
    }
  })
})
