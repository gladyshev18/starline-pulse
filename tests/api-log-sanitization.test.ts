import { describe, expect, it } from 'vitest'
import { sanitizeBody, sanitizeEndpoint, sanitizeHeaders, sanitizeUrl } from '../worker/starline/budget'

describe('API log sanitization', () => {
  it('masks secrets in URL parameters without hiding ordinary diagnostic data', () => {
    const result = sanitizeUrl('https://example.test/device?appId=42&secret=top-secret&verbose=true')
    expect(result).toContain('appId=42')
    expect(result).toContain('verbose=true')
    expect(result).not.toContain('top-secret')
  })

  it('masks sensitive headers', () => {
    const result = sanitizeHeaders({ authorization: 'Bearer secret', cookie: 'sid=secret', accept: 'application/json' })
    expect(result).toContain('application/json')
    expect(result).not.toContain('Bearer secret')
    expect(result).not.toContain('sid=secret')
  })

  it('recursively masks secrets in JSON while retaining the API payload', () => {
    const result = sanitizeBody(JSON.stringify({
      code: 200,
      data: { mileage: 123, user_token: 'secret-token', telephone: '+79990000000', x: 37.6, shock_bpass: false, front_pass_door: false }
    }), 'application/json')
    expect(result).toContain('"mileage": 123')
    expect(result).toContain('"shock_bpass": false')
    expect(result).toContain('"front_pass_door": false')
    expect(result).not.toContain('secret-token')
    expect(result).not.toContain('+79990000000')
    expect(result).not.toContain('37.6')
  })

  it('masks device identifiers in API paths', () => {
    expect(sanitizeEndpoint('/json/v3/device/864326067589782/data')).toBe('/json/v3/device/[СКРЫТО]/data')
  })

  it('masks credentials in form bodies', () => {
    const result = sanitizeBody('login=owner&pass=secret&captchaCode=1234&remember=true', 'application/x-www-form-urlencoded')
    expect(result).toContain('remember=true')
    expect(result).not.toContain('owner')
    expect(result).not.toContain('secret')
    expect(result).not.toContain('1234')
  })
})
