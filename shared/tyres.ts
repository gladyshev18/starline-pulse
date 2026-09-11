import type { AmbientDay } from './ambient'
import { plural } from './plural'
import { linearFit, predict, type Fit } from './regression'

// Когда переобуваться. Ответ у всей отрасли один и тот же: около +7 °C графики
// сцепления летней и зимней резины пересекаются, и держать летнюю ниже этой
// черты — значит ездить на том, что уже дубеет. Считать надо по среднесуточной
// температуре, а не по дневной: днём +12 при ночных нулях — это зима, и утренний
// лёд встречает именно летняя резина. И считать надо не по одному дню: речь про
// устойчивый переход, а не про случайное похолодание в середине сентября.
//
// Обратный переход, на летнюю, — тот же порог, но осторожность в другую
// сторону: весной спешить нечем, зато ночные заморозки возвращаются ещё долго
// после того, как средняя перевалила за +7. Поэтому весной к порогу добавлено
// условие «неделя без заморозков», а осенью, наоборот, первый же ночной минус
// объявляет смену независимо от средней.
export const SWITCH_CELSIUS = 7

// Запас. Между «пора» и «переобут» стоит запись в шиномонтаж, а в сезон это
// неделя очереди. Пять градусов среднесуточной — примерно она и есть: осенью
// температура падает по полградуса в сутки, так что предупреждение на +12
// приходит дней за десять до того, как ездить на летней станет нельзя.
export const MARGIN_CELSIUS = 5

// Сколько суток подряд должна продержаться погода, чтобы переход считался
// состоявшимся. Трое суток — то, о чём договорились и шинники, и синоптики:
// меньше — это погода, больше — это опоздание.
export const SUSTAINED_DAYS = 3

// Ниже нуля ночью — это уже лёд на мосту утром, какой бы ни была средняя.
export const FROST_CELSIUS = 0
export const FROST_WINDOW_DAYS = 7

// Выше этого зимняя резина не просто быстрее стирается — она хуже тормозит на
// сухом. Весной эта черта означает, что смену уже проспали.
export const OVERHEATED_WINTER_CELSIUS = 15

// Насколько назад смотрит прямая, по которой считается прогноз. Две недели —
// компромисс: на неделе прямую ведёт любой циклон, на месяце она сглаживает как
// раз тот перелом, ради которого всё и затевалось.
export const TREND_DAYS = 14

// Дальше этого срока прогноз не выдаётся. Экстраполяция осеннего наклона на два
// месяца вперёд даёт минус сорок и никого не обманывает только потому, что
// такие числа сразу видно.
const FORECAST_HORIZON_DAYS = 45

// Ряд не должен быть протухшим: если последние сутки с погодой были неделю
// назад, «средняя за трое суток» описывает прошлую неделю, а решение принимают
// про сегодня.
const FRESH_DAYS = 3

const DAY_MS = 24 * 60 * 60_000

export type TyreSeason = 'winter' | 'summer'
// `far` — до смены далеко; `edge` — средняя ещё держится, но края суток уже
// перешли порог; `soon` — вошли в запас, пора записываться; `now` — порог
// перейден устойчиво; `late` — тянуть уже опасно.
export type TyreStatus = 'unknown' | 'far' | 'edge' | 'soon' | 'now' | 'late'

// Ночи, которые живут уже в другом сезоне, чем их собственное среднее: средняя
// держит +13, а под утро +4, и сцепление у летней резины в этот час не то, к
// которому привыкли днём. Весной такой промежуток тоже есть, но разбирает его
// не эта величина, а заморозки: они и без того держат зимнюю резину на месте.
export interface TyreEdge {
  // Сколько ночей за неделю попало.
  nights: number
  // Самая холодная из них.
  coldest: number
}

export interface TyreWatch {
  // На какую резину смотрим: зимой впереди зима, весной и летом — лето.
  season: TyreSeason
  status: TyreStatus
  // Средняя за последние `SUSTAINED_DAYS` суток — то самое число, по которому
  // принимается решение.
  sustained: number | null
  // Последние сутки ряда, чтобы было видно, насколько свежо решение.
  latest: AmbientDay | null
  days: number
  // Сколько суток из тех, что дали решающую среднюю, восстановлены по
  // суточному ходу, а не измерены целиком.
  estimatedDays: number
  // Ночей ниже нуля за последнюю неделю и самая холодная из них.
  frostNights: number
  coldestNight: number | null
  edge: TyreEdge | null
  // Порог, до которого осталось дойти, и порог с запасом.
  threshold: number
  warnAt: number
  trend: Fit | null
  // На сколько градусов в сутки меняется среднесуточная. Отрицательное — холодает.
  perDay: number | null
  // Когда средняя дойдёт до порога, если погода продолжит в том же духе.
  crossingAt: Date | null
  daysToCrossing: number | null
}

function emptyWatch(season: TyreSeason): TyreWatch {
  return {
    season,
    status: 'unknown',
    sustained: null,
    latest: null,
    days: 0,
    estimatedDays: 0,
    frostNights: 0,
    coldestNight: null,
    edge: null,
    threshold: SWITCH_CELSIUS,
    warnAt: season === 'winter' ? SWITCH_CELSIUS + MARGIN_CELSIUS : SWITCH_CELSIUS - MARGIN_CELSIUS,
    trend: null,
    perDay: null,
    crossingAt: null,
    daysToCrossing: null
  }
}

// Какую смену ждём. Календарь, а не сама температура: в августе похолодание до
// +6 — это всё ещё осень впереди, а не «пора на летнюю». Август выбран началом
// зимнего ожидания с запасом — раньше средняя до +12 не опускается нигде, — а
// январь ещё входит в него, потому что не переобувшийся к январю обязан
// услышать это и в январе.
export function tyreSeason(now = new Date()) {
  const month = new Date(now.getTime() + 3 * 60 * 60_000).getUTCMonth() + 1
  return month >= 8 || month === 1 ? 'winter' : 'summer'
}

function parseDay(day: string) {
  return Date.parse(`${day}T12:00:00+03:00`)
}

export function tyreWatch(days: AmbientDay[], now = new Date()): TyreWatch {
  const season = tyreSeason(now)
  const sorted = days
    .filter(item => Number.isFinite(item.mean))
    .sort((left, right) => parseDay(left.day) - parseDay(right.day))
  const watch = emptyWatch(season)
  watch.days = sorted.length
  const latest = sorted.at(-1) ?? null
  watch.latest = latest
  if (!latest) return watch

  // Протухший ряд не описывает сегодняшнюю погоду, но и выбрасывать его молча
  // нельзя: «не знаю» — это отдельный ответ, а не отсутствие ответа.
  if (now.getTime() - parseDay(latest.day) > FRESH_DAYS * DAY_MS) return watch

  const recent = sorted.slice(-SUSTAINED_DAYS)
  if (recent.length < SUSTAINED_DAYS) return watch
  const sustained = recent.reduce((sum, item) => sum + item.mean, 0) / recent.length
  watch.sustained = sustained
  watch.estimatedDays = recent.filter(item => item.estimated).length

  const frostFrom = parseDay(latest.day) - (FROST_WINDOW_DAYS - 1) * DAY_MS
  const week = sorted.filter(item => parseDay(item.day) >= frostFrom)
  watch.frostNights = week.filter(item => item.night < FROST_CELSIUS).length
  watch.coldestNight = week.length ? Math.min(...week.map(item => item.night)) : null
  watch.edge = season === 'winter' ? coldNights(week) : null

  watch.status = season === 'winter'
    ? winterStatus(sustained, watch.frostNights, watch.edge)
    : summerStatus(sustained, watch.frostNights)

  // Прямая по последним двум неделям. Иксом идут не порядковые номера точек, а
  // сутки от начала окна: пропущенный день не должен сжимать время.
  const window = sorted.filter(item => parseDay(item.day) > parseDay(latest.day) - TREND_DAYS * DAY_MS)
  const origin = window.length ? parseDay(window[0]!.day) : 0
  const trend = linearFit(window.map(item => ({ x: (parseDay(item.day) - origin) / DAY_MS, y: item.mean })))
  watch.trend = trend
  if (!trend?.significant) return watch
  watch.perDay = trend.slope

  // Прогноз имеет смысл, только когда прямая идёт в сторону порога: осенью вниз,
  // весной вверх. Потеплению в октябре сказать про смену шин нечего.
  const wanted = season === 'winter' ? -1 : 1
  if (Math.sign(trend.slope) !== wanted) return watch

  const atThreshold = (SWITCH_CELSIUS - trend.intercept) / trend.slope
  const fromLatest = (parseDay(latest.day) - origin) / DAY_MS
  const daysLeft = atThreshold - fromLatest
  if (daysLeft > FORECAST_HORIZON_DAYS) return watch

  // Порог уже позади — прогнозировать нечего, об этом говорит сам статус.
  watch.daysToCrossing = Math.max(0, Math.round(daysLeft))
  watch.crossingAt = new Date(parseDay(latest.day) + Math.max(0, daysLeft) * DAY_MS)
  return watch
}

// Средняя за сутки — это середина, и середина умеет врать. В сентябре она
// держится на +13, пока под утро уже +4: резина сводок не читает, она работает
// той температурой, какая под ней сейчас. Поэтому края суток считаются
// отдельно — не чтобы отправить в шиномонтаж раньше срока, а чтобы сказать, в
// какие часы машина едет уже не так, как днём.
function coldNights(week: AmbientDay[]): TyreEdge | null {
  // Ночи ниже нуля — это уже не «будьте внимательнее», а смена шин, и такие
  // ночи разбирает статус, а не примечание.
  const nights = week.filter(item => item.night <= SWITCH_CELSIUS && item.night >= FROST_CELSIUS)
  if (!nights.length) return null
  return { nights: nights.length, coldest: Math.min(...nights.map(item => item.night)) }
}

function winterStatus(sustained: number, frostNights: number, edge: TyreEdge | null): TyreStatus {
  if (sustained <= FROST_CELSIUS) return 'late'
  // Ночной минус решает сам, без средней: до утреннего льда ей нет дела.
  if (sustained <= SWITCH_CELSIUS || frostNights > 0) return 'now'
  if (sustained <= SWITCH_CELSIUS + MARGIN_CELSIUS) return 'soon'
  return edge ? 'edge' : 'far'
}

function summerStatus(sustained: number, frostNights: number): TyreStatus {
  if (sustained >= OVERHEATED_WINTER_CELSIUS) return 'late'
  // Весной средняя перебирается через +7 задолго до того, как заканчиваются
  // ночные заморозки, и переобуться в этот промежуток — ровно та ошибка, из-за
  // которой в апреле собирают машины в кюветах.
  if (sustained >= SWITCH_CELSIUS && !frostNights) return 'now'
  return sustained >= SWITCH_CELSIUS - MARGIN_CELSIUS ? 'soon' : 'far'
}

// Градусы всегда со знаком: «4 °C» и «−4 °C» в разговоре про шины — это разные
// времена года, и потерянный минус стоит дороже лишнего плюса.
const celsius = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero'
})

export function degrees(value: number) {
  return `${celsius.format(value)} °C`
}

// Одной строкой: что сейчас за окном и что с этим делать. Нужна и отчёту в
// Telegram, и карточке на странице статистики.
// Берут ровно то, что читают: страница получает наблюдение через JSON, где
// `crossingAt` уже не дата, а строка, и требовать от неё целиком `TyreWatch`
// значило бы требовать того, чего по дороге не пережило.
export function tyreVerdict(watch: Pick<TyreWatch, 'season' | 'status'>) {
  const target = watch.season === 'winter' ? 'зимнюю' : 'летнюю'
  if (watch.status === 'unknown') return `Погоды пока не хватает, чтобы судить о смене на ${target}`
  if (watch.status === 'far') return `До смены на ${target} далеко`
  if (watch.status === 'edge') return 'Менять рано, но ночью дорога уже зимняя'
  if (watch.status === 'soon') return `Пора записываться в шиномонтаж: до порога меньше ${MARGIN_CELSIUS} градусов`
  if (watch.status === 'now') return `Пора менять на ${target}`
  return `Менять на ${target} надо было ещё вчера`
}

// Предупреждение про края суток. Отдельно от вердикта: оно не про то, когда
// переобуваться, а про то, что между «ещё рано» и «уже пора» лежат недели,
// когда одна и та же резина держит дорогу днём и не держит ночью.
export function tyreEdgeNote(watch: Pick<TyreWatch, 'status' | 'edge'>) {
  const edge = watch.edge
  // После того как порог перейден, предупреждать про часы уже нечем: вердикт
  // говорит «менять», и приписка «а ночью бывает холоднее» только размывает его.
  if (!edge || (watch.status !== 'edge' && watch.status !== 'soon')) return null
  const nights = plural(edge.nights, 'ночь', 'ночи', 'ночей')
  return `За неделю ${edge.nights} ${nights} опускались до ${degrees(edge.coldest)}, и это уже зимняя дорога. `
    + 'Ночью и ранним утром летняя резина держит хуже, чем днём: дистанция побольше, в поворотах и на тормозе — аккуратнее.'
}

// Прогноз средней на сутки вперёд — для подписи к графику: прямая, продлённая
// на день, отвечает на вопрос «завтра будет теплее или холоднее» без обещаний
// на месяц.
export function ambientTomorrow(watch: TyreWatch) {
  if (!watch.trend?.significant || !watch.latest) return null
  return predict(watch.trend, watch.trend.maxX + 1)
}
