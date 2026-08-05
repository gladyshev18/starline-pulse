import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../db/client'
import { config } from '../worker/config'
import { getSlnet, starlineRequest } from '../worker/starline/auth'

if (!config.starlineDeviceId) throw new Error('Set STARLINE_DEVICE_ID in .env')
const database = createDatabase(config.databaseUrl)
const slnet = await getSlnet(database)
const url = `https://developer.starline.ru/json/v3/device/${encodeURIComponent(config.starlineDeviceId)}/data`
const response = await starlineRequest(database, url, { headers: { cookie: `slnet=${slnet}` } })
const raw = await response.text()
if (!response.ok) throw new Error(`StarLine probe failed: ${response.status} ${raw}`)
JSON.parse(raw)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(root, 'fixtures', 'starline-device.json')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `${raw}\n`, 'utf8')
console.log(`Fixture written to ${target}`)
