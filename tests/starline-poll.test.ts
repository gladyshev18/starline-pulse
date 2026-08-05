import { describe, expect, it, vi } from 'vitest'
import { normalizeDeviceResponse, readLoggedDeviceResponse } from '../worker/starline/poll'

describe('normalizeDeviceResponse', () => {
  it('extracts the complete vehicle snapshot from one response', () => {
    const result = normalizeDeviceResponse({ code: 200, data: {
      alias: 'Chery', device_id: 42, activity_ts: 1_700_000_000,
      position: { x: 55.7, y: 37.6 }, common: { battery: 12.4, ctemp: 22, etemp: 70, gsm_lvl: 19 },
      obd: { mileage: 1234.5, fuel_litres: 31.2 }, state: { ign: true }
    } })
    expect(result).toMatchObject({ deviceId: '42', alias: 'Chery', ignition: true, mileage: 1234.5, fuel: 31.2, battery: 12.4, lat: 55.7, lon: 37.6 })
  })

  it('preserves unavailable OBD values as null', () => {
    const result = normalizeDeviceResponse({ code: 200, data: { alias: 'Chery', device_id: 42, activity_ts: 1, obd: {}, state: { ign: false } } })
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
      expect(info).toHaveBeenCalledWith(`[starline.api.raw] status=200 content-type=application/json body=${rawBody}`)
    } finally {
      info.mockRestore()
    }
  })

  it('logs an invalid API body before JSON parsing fails', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expect(readLoggedDeviceResponse(new Response('upstream error', { status: 502 }))).rejects.toThrow()
      expect(info).toHaveBeenCalledWith(expect.stringContaining('status=502'))
      expect(info).toHaveBeenCalledWith(expect.stringContaining('body=upstream error'))
    } finally {
      info.mockRestore()
    }
  })
})
