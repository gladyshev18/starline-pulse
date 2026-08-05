import { describe, expect, it } from 'vitest'
import { sanitizeBody, sanitizeHeaders, sanitizeUrl } from '../worker/starline/budget'

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
    const result = sanitizeBody(JSON.stringify({ code: 200, data: { mileage: 123, user_token: 'secret-token' } }), 'application/json')
    expect(result).toContain('"mileage": 123')
    expect(result).not.toContain('secret-token')
  })

  it('masks credentials in form bodies', () => {
    const result = sanitizeBody('login=owner&pass=secret&captchaCode=1234&remember=true', 'application/x-www-form-urlencoded')
    expect(result).toContain('remember=true')
    expect(result).not.toContain('owner')
    expect(result).not.toContain('secret')
    expect(result).not.toContain('1234')
  })
})
