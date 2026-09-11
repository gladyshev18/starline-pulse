import type { Database } from '../../db/client'
import { emptyTyreOutlook, tyreOutlook } from '../../metrics/tyres'
import { plural } from '../../shared/plural'
import { degrees, FROST_WINDOW_DAYS, MARGIN_CELSIUS, SUSTAINED_DAYS, SWITCH_CELSIUS, tyreEdgeNote, type TyreSeason, type TyreStatus, type TyreWatch } from '../../shared/tyres'
import { nextMoscowHourRun } from './reports'

// Утро, а не вечер: между «пора» и «переобут» стоит звонок в шиномонтаж, и
// сделать его можно только в рабочее время того же дня.
const WATCH_HOUR = 10

// Насколько статус серьёзнее предыдущего. Говорить есть смысл только при
// движении вверх по этой лестнице: потепление в октябре не отменяет уже
// сказанного «пора», и повторять его на следующем похолодании незачем.
const SEVERITY: Record<TyreStatus, number> = { unknown: -1, far: 0, edge: 1, soon: 2, now: 3, late: 4 }

const rate = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const dateOnly = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })

export function nextTyreWatchRun(now = new Date()) {
  return nextMoscowHourRun(WATCH_HOUR, now)
}

// Состояние, которое уведомление о себе помнит: о чём в этом сезоне уже
// говорили. Сезон хранится вместе со статусом, чтобы весной лестница начиналась
// заново, а не считала «пора на летнюю» шагом вниз от осеннего «пора на зимнюю».
export interface TyreNoticeState {
  season: TyreSeason | null
  status: TyreStatus | null
}

export function parseTyreNoticeState(payload: Record<string, unknown>): TyreNoticeState {
  const season = payload.season === 'winter' || payload.season === 'summer' ? payload.season : null
  const status = typeof payload.status === 'string' && payload.status in SEVERITY ? payload.status as TyreStatus : null
  return { season, status }
}

function trendLine(watch: TyreWatch) {
  if (watch.perDay == null) return null
  const direction = watch.perDay < 0 ? 'холодает' : 'теплеет'
  const speed = `${direction} на ${rate.format(Math.abs(watch.perDay))} °C в сутки`
  if (!watch.crossingAt || watch.daysToCrossing == null) return speed
  const when = watch.daysToCrossing === 0
    ? 'порог уже перейден'
    : `порог ${degrees(SWITCH_CELSIUS)} ожидается ${dateOnly.format(watch.crossingAt)}`
  return `${speed}, ${when}`
}

function frostLine(watch: TyreWatch) {
  if (!watch.frostNights) return null
  const nights = plural(watch.frostNights, 'ночь', 'ночи', 'ночей')
  const coldest = watch.coldestNight != null ? `, самая холодная ${degrees(watch.coldestNight)}` : ''
  return `За неделю ${watch.frostNights} ${nights} ниже нуля${coldest}.`
}

function winterBody(watch: TyreWatch, average: string) {
  // Средняя ещё летняя, менять рано — и говорится здесь не про шиномонтаж, а
  // про то, что до него остались часы, когда дорога уже другая.
  if (watch.status === 'edge') {
    return [
      '🛞 <b>Ночью уже зима</b>',
      `${average}, до порога ${degrees(SWITCH_CELSIUS)} ещё далеко — переобуваться рано.`,
      tyreEdgeNote(watch),
      trendLine(watch)
    ]
  }
  if (watch.status === 'soon') {
    return [
      `🛞 <b>Скоро на зимнюю</b>`,
      `${average}, до порога ${degrees(SWITCH_CELSIUS)} осталось меньше ${MARGIN_CELSIUS} градусов.`,
      trendLine(watch),
      tyreEdgeNote(watch),
      'Пора записываться в шиномонтаж: в сезон запись уходит на неделю вперёд.'
    ]
  }
  if (watch.status === 'now') {
    return [
      `🛞 <b>Пора на зимнюю</b>`,
      `${average}.`,
      watch.frostNights
        ? frostLine(watch)
        : `Это ниже порога ${degrees(SWITCH_CELSIUS)}, на котором летняя резина отдаёт сцепление зимней.`,
      'Ездить на летней дальше — это тормозной путь длиннее и лёд на утреннем мосту.'
    ]
  }
  return [
    `🛞 <b>Зима уже наступила, а резина летняя</b>`,
    `${average}.`,
    frostLine(watch),
    'Переобуваться надо не откладывая: по такой погоде летняя резина не держит дорогу ни в повороте, ни в торможении.'
  ]
}

function summerBody(watch: TyreWatch, average: string) {
  if (watch.status === 'soon') {
    return [
      `🛞 <b>Скоро на летнюю</b>`,
      `${average}, до порога ${degrees(SWITCH_CELSIUS)} осталось меньше ${MARGIN_CELSIUS} градусов.`,
      trendLine(watch),
      frostLine(watch) ? `${frostLine(watch)} Пока заморозки возвращаются, переобуваться рано.` : 'Можно записываться в шиномонтаж.',
      tyreEdgeNote(watch)
    ]
  }
  if (watch.status === 'now') {
    return [
      `🛞 <b>Пора на летнюю</b>`,
      `${average}, и ${FROST_WINDOW_DAYS} суток без ночных заморозков.`,
      'Зимняя резина на тепле хуже тормозит на сухом асфальте и стирается втрое быстрее.'
    ]
  }
  return [
    `🛞 <b>Зимняя резина давно лишняя</b>`,
    `${average}.`,
    'На такой погоде зимний состав плывёт: тормозной путь на сухом длиннее летнего, а шашки стираются за сезон.'
  ]
}

export interface TyreNotice {
  season: TyreSeason
  status: TyreStatus
  text: string
}

// Что сказать про наблюдение — и говорить ли вообще. `null` значит, что повода
// нет: до смены далеко, погоды не хватает на решение или об этом статусе в этом
// сезоне уже сообщали.
export function tyreNotice(watch: TyreWatch, previous: TyreNoticeState): TyreNotice | null {
  if (watch.sustained == null || watch.status === 'unknown' || watch.status === 'far') return null

  const announced = previous.season === watch.season && previous.status ? SEVERITY[previous.status] : -1
  if (SEVERITY[watch.status] <= announced) return null

  const average = `Среднесуточная за ${SUSTAINED_DAYS} суток — ${degrees(watch.sustained)}`
  const lines = watch.season === 'winter' ? winterBody(watch, average) : summerBody(watch, average)
  return {
    season: watch.season,
    status: watch.status,
    text: lines.filter(Boolean).join('\n')
  }
}

export async function buildTyreNotice(database: Database, previous: TyreNoticeState, now = new Date()): Promise<TyreNotice | null> {
  const vehicle = await database.query.vehicles.findFirst()
  const outlook = vehicle ? await tyreOutlook(database, vehicle.id, now) : emptyTyreOutlook(now)
  return tyreNotice(outlook.watch, previous)
}
