import 'dotenv/config'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const server = spawn(process.execPath, [resolve(root, '.output', 'server', 'index.mjs')], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
let stderr = ''
server.stderr.on('data', chunk => { stderr += chunk })

try {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    if (server.exitCode != null) throw new Error(`Server exited early: ${stderr}`)
    try {
      const response = await fetch('http://localhost:3000/login')
      if (response.status === 200) { ready = true; break }
    } catch {}
    await delay(200)
  }
  if (!ready) throw new Error(`Server did not become ready: ${stderr}`)

  const anonymous = await fetch('http://localhost:3000/api/dashboard')
  if (anonymous.status !== 401) throw new Error(`Anonymous API status was ${anonymous.status}`)
  const login = await fetch('http://localhost:3000/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: process.env.SEED_USER_1_LOGIN, password: process.env.SEED_USER_1_PASSWORD })
  })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  if (login.status !== 200 || !cookie) throw new Error(`Login status was ${login.status}`)
  const dashboard = await fetch('http://localhost:3000/api/dashboard', { headers: { cookie } })
  if (dashboard.status !== 200) throw new Error(`Authenticated dashboard status was ${dashboard.status}`)
  const data = await dashboard.json()
  console.log(JSON.stringify({ anonymous: anonymous.status, login: login.status, dashboard: dashboard.status, vehicle: data.vehicle?.alias }))
} finally {
  if (server.exitCode == null) {
    server.kill('SIGTERM')
    await Promise.race([once(server, 'exit'), delay(2_000)])
  }
}
