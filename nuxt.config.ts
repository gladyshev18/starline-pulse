import { isAbsolute, resolve } from 'node:path'

function databaseUrl() {
  const configured = process.env.DATABASE_URL || 'file:./data/app.db'
  if (!configured.startsWith('file:')) return configured
  const value = configured.slice(5)
  const path = isAbsolute(value) ? value : resolve(import.meta.dirname, value)
  return `file:${path.replaceAll('\\', '/')}`
}

export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  devtools: { enabled: false },
  modules: ['nuxt-auth-utils'],
  css: ['~/assets/css/main.css'],
  ssr: true,
  runtimeConfig: {
    databaseUrl: databaseUrl(),
    session: {
      maxAge: 60 * 60 * 24 * 30,
      cookie: { sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' }
    }
  },
  nitro: {
    preset: 'node-server'
  },
  typescript: { strict: true, typeCheck: true },
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'Chery Pulse',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg?v=2' },
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico?v=2' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png?v=2' },
        { rel: 'manifest', href: '/site.webmanifest?v=2' },
        { rel: 'preload', href: '/fonts/manrope-cyrillic-wght-normal.woff2', as: 'font', type: 'font/woff2', crossorigin: 'anonymous' },
        { rel: 'preload', href: '/fonts/manrope-latin-wght-normal.woff2', as: 'font', type: 'font/woff2', crossorigin: 'anonymous' }
      ],
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#f4f8f6' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'apple-mobile-web-app-title', content: 'Chery Pulse' },
        { name: 'description', content: 'Личный журнал поездок и состояние автомобиля' }
      ]
    }
  }
})
