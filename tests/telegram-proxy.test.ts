import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { closeTelegramProxy, createTelegramProxyFetch } from '../worker/bot/proxy'
import { normalizeTelegramProxyUrl } from '../worker/config'

afterEach(() => closeTelegramProxy())

describe('Telegram proxy transport', () => {
  it('normalizes socks5h URLs for the undici SOCKS5 transport', () => {
    expect(normalizeTelegramProxyUrl(' socks5h://user:pass@proxy.example:1080 '))
      .toBe('socks5://user:pass@proxy.example:1080')
  })

  it('routes Bot API HTTP requests through the configured proxy', async () => {
    let requestedUrl = ''
    const proxy = createServer((request, response) => {
      requestedUrl = request.url || ''
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      response.end('{"ok":true}')
    })
    proxy.on('connect', (request, socket) => {
      requestedUrl = request.url || ''
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.once('data', () => socket.end([
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        'Content-Length: 11',
        'Connection: close',
        '',
        '{"ok":true}'
      ].join('\r\n')))
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = proxy.address()
      if (!address || typeof address === 'string') throw new Error('Proxy test server has no TCP address')
      const proxyFetch = createTelegramProxyFetch(`http://127.0.0.1:${address.port}`)
      const response = await proxyFetch('http://telegram.invalid/bot-token/getMe')

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(requestedUrl).toMatch(/telegram\.invalid/)
    } finally {
      await closeTelegramProxy()
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
    }
  })
})
