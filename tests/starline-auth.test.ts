import { describe, expect, it } from 'vitest'
import { isSuccessfulStarLineCode, parseStarLineUserLogin } from '../worker/starline/auth'

describe('isSuccessfulStarLineCode', () => {
  it('accepts numeric and string success codes returned by different StarLine endpoints', () => {
    expect(isSuccessfulStarLineCode(200)).toBe(true)
    expect(isSuccessfulStarLineCode('200')).toBe(true)
    expect(isSuccessfulStarLineCode(401)).toBe(false)
  })
})

describe('parseStarLineUserLogin', () => {
  it('extracts a successful user token and id', () => {
    expect(parseStarLineUserLogin({ state: 1, desc: { id: 42, user_token: 'token:42' } })).toEqual({
      status: 'success', userToken: 'token:42', userId: '42'
    })
  })

  it('extracts a CAPTCHA challenge', () => {
    expect(parseStarLineUserLogin({ state: 0, desc: {
      message: 'Captcha needed.', captchaSid: 'captcha-id', captchaImg: 'https://id.starline.ru/captcha/image'
    } })).toEqual({
      status: 'captcha', captchaSid: 'captcha-id', captchaImg: 'https://id.starline.ru/captcha/image'
    })
  })

  it('extracts an SMS challenge', () => {
    expect(parseStarLineUserLogin({ state: 2, desc: { message: 'Need confirmation.', phone: '7xxxx60', TTL: 41 } })).toEqual({
      status: 'sms', phone: '7xxxx60', ttl: 41
    })
  })

  it('preserves an ordinary login error', () => {
    expect(parseStarLineUserLogin({ state: 0, desc: { message: 'Incorrect username or password.' } })).toEqual({
      status: 'error', message: 'Incorrect username or password.'
    })
  })
})
