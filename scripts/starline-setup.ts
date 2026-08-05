import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { createDatabase } from '../db/client'
import { getStoredStarLineUser, loginStarLineUser, getSlnet, isSuccessfulStarLineCode, starlineRequest } from '../worker/starline/auth'
import { config } from '../worker/config'

interface DeviceListPayload {
  code?: number
  codestring?: string
  data?: {
    devices?: Array<{
      device_id?: string | number
      alias?: string
      status?: string
    }>
  }
}

if (config.starlineMode !== 'live') throw new Error('Перед настройкой StarLine установите STARLINE_MODE=live')
if (!config.starlineAppId || !config.starlineAppSecret || !config.starlineLogin || !config.starlinePassword) {
  throw new Error('Реквизиты StarLine заполнены не полностью')
}

const database = createDatabase(config.databaseUrl)
const terminal = createInterface({ input, output })

try {
  let continuation: { captchaSid?: string, captchaCode?: string, smsCode?: string } = {}
  const storedUser = await getStoredStarLineUser(database)
  let userId = storedUser?.userId || ''
  if (storedUser) console.log('Используется сохранённый токен пользователя StarLine')

  for (let attempt = 1; !userId && attempt <= 5; attempt++) {
    const result = await loginStarLineUser(database, continuation)
    if (result.status === 'success') {
      userId = result.userId
      console.log('Токен пользователя StarLine сохранён')
      break
    }
    if (result.status === 'captcha') {
      console.log(`Откройте изображение CAPTCHA в браузере:\n${result.captchaImg}`)
      const captchaCode = (await terminal.question('Введите код с изображения: ')).trim()
      if (!captchaCode) throw new Error('Код CAPTCHA не может быть пустым')
      continuation = { captchaSid: result.captchaSid, captchaCode }
      continue
    }
    if (result.status === 'sms') {
      const destination = result.phone ? `, отправленный на ${result.phone}` : ''
      const smsCode = (await terminal.question(`Введите SMS-код StarLine${destination}: `)).trim()
      if (!smsCode) throw new Error('SMS-код не может быть пустым')
      continuation = { smsCode }
      continue
    }
    throw new Error(`StarLine user login: ${result.message}`)
  }

  if (!userId) throw new Error('Не удалось завершить авторизацию StarLine за 5 попыток')

  const slnet = await getSlnet(database)
  const url = `https://developer.starline.ru/json/v1/user/${encodeURIComponent(userId)}/deviceList?alias=true&status=true`
  const response = await starlineRequest(database, url, { headers: { cookie: `slnet=${slnet}` } })
  const payload = await response.json() as DeviceListPayload
  if (!isSuccessfulStarLineCode(payload.code)) throw new Error(`StarLine device list: ${payload.codestring || payload.code || response.status}`)

  const devices = payload.data?.devices?.filter(device => device.device_id != null) || []
  if (!devices.length) {
    console.log('Авторизация выполнена, но StarLine не вернул ни одного устройства')
  } else {
    console.log('\nДоступные устройства StarLine:')
    for (const device of devices) {
      const details = [device.alias, device.status].filter(Boolean).join(', ')
      console.log(`STARLINE_DEVICE_ID=${device.device_id}${details ? `  # ${details}` : ''}`)
    }
    console.log('\nСкопируйте нужный STARLINE_DEVICE_ID в .env.production и пересоздайте контейнер worker.')
  }
} finally {
  terminal.close()
}
