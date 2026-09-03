// Oil does not wear out by distance. It wears out by how long the engine has
// been turning, by how hot it got, and by how long it has been sitting in the
// sump oxidising. The manual states the interval in kilometres only because a
// car has an odometer and no one reads engine hours — but this car has one, and
// it disagrees with the odometer precisely when it matters: an hour spent
// warming up or crawling in traffic ages the oil exactly as much as an hour on
// the motorway, and adds a twentieth of the kilometres.
export const OIL_INTERVAL_KM = 10_000
export const OIL_INTERVAL_MONTHS = 12

// Not derived from the kilometre interval but taken from what oil actually
// lasts. The figures agreed on across the trade: synthetic oil in ordinary use
// holds 250-300 engine-hours, and in hard use — winter, city traffic, a
// turbocharged engine — 200-250; semi-synthetic 250, mineral 150. This car sits
// in the hard-use band: its own trip log shows 18.8 l/100 km in jams and about
// 42 km per engine-hour overall. So 250 is the upper edge of the band it
// belongs to rather than a guess, and it is the one number to change for a
// different oil.
export const OIL_INTERVAL_MOTOR_HOURS = 250

// The average speed at which the two intervals would expire together. Below it
// the engine-hours run out first and the odometer would send you for an oil
// change too late; above it the distance interval is the conservative one.
export const OIL_EQUIVALENT_SPEED_KMH = OIL_INTERVAL_KM / OIL_INTERVAL_MOTOR_HOURS

export type OilClockName = 'km' | 'hours' | 'months'

export interface OilClock {
  name: OilClockName
  used: number
  interval: number
  // How much of the interval is gone. Above 1 the service is overdue.
  share: number
  remaining: number
}

export interface OilLifeInput {
  km: number | null
  motorHours: number | null
  months: number | null
}

export interface OilLife {
  clocks: OilClock[]
  // The clock that will run out first — the one the service is actually due on.
  binding: OilClock | null
  share: number | null
  overdue: boolean
}

function clock(name: OilClockName, used: number | null, interval: number): OilClock | null {
  if (used == null || !Number.isFinite(used) || used < 0) return null
  return { name, used, interval, share: used / interval, remaining: Math.max(0, interval - used) }
}

export function oilLife(input: OilLifeInput): OilLife {
  const clocks = [
    clock('km', input.km, OIL_INTERVAL_KM),
    clock('hours', input.motorHours, OIL_INTERVAL_MOTOR_HOURS),
    clock('months', input.months, OIL_INTERVAL_MONTHS)
  ].filter((value): value is OilClock => value != null)

  // Whichever clock is furthest along is the one the oil is actually living on;
  // servicing by the slower of them is what makes a kilometre interval unsafe
  // for a car that idles a lot.
  const binding = clocks.reduce<OilClock | null>((worst, item) => !worst || item.share > worst.share ? item : worst, null)
  return {
    clocks,
    binding,
    share: binding?.share ?? null,
    overdue: (binding?.share ?? 0) >= 1
  }
}

// How much sooner the engine-hour clock arrives than the odometer would suggest.
// Positive means the car idles or crawls more than the interval assumes, so
// servicing on kilometres alone would change the oil late; negative means it
// spends its life on the motorway and the kilometre interval is conservative.
export function oilClockGap(life: OilLife) {
  const km = life.clocks.find(item => item.name === 'km')
  const hours = life.clocks.find(item => item.name === 'hours')
  if (!km || !hours) return null
  return hours.share - km.share
}

// The distance this car actually covers per engine-hour. Compared against
// OIL_EQUIVALENT_SPEED_KMH it says in one number which interval governs: the
// trade's own conversion is 70-90 km/h on the motorway, 30-40 in a city without
// jams and 10-20 in dense traffic.
export function kmPerMotorHour(km: number | null, motorHours: number | null) {
  if (km == null || motorHours == null || !(motorHours > 0)) return null
  return km / motorHours
}

// Календарный интервал задан в месяцах, а темп считается в сутках, поэтому
// средний месяц нужен обоим: без него «12 месяцев» не переводятся в дни, а
// суточный темп не с чем сравнивать.
const DAYS_IN_MONTH = 30.437
const DAY_MS = 24 * 60 * 60_000
export const OIL_INTERVAL_DAYS = OIL_INTERVAL_MONTHS * DAYS_IN_MONTH

// Норма пробега: столько километров в сутки укладывается ровно в интервал —
// 10 000 км за год. Едешь больше — километры кончатся раньше календаря, и ровно
// во столько раз раньше, во сколько суточный темп выше нормы.
export const OIL_KM_PER_DAY = OIL_INTERVAL_KM / OIL_INTERVAL_DAYS
export const OIL_MOTOR_HOURS_PER_DAY = OIL_INTERVAL_MOTOR_HOURS / OIL_INTERVAL_DAYS

// Меньше суток после замены темп не показывает: сорок километров за два часа
// превращаются в пятьсот километров в день, и прогноз по такому числу — не
// осторожная оценка, а арифметика без смысла.
const MIN_PACE_DAYS = 1

export interface OilPaceClock {
  name: OilClockName
  // Сколько ресурса шкала тратит в сутки на самом деле.
  perDay: number
  // Сколько в сутки отпускает интервал.
  normPerDay: number
  // Отношение одного к другому: 1,5 значит, что шкала обгоняет календарь в
  // полтора раза, то есть на 50 %. Это же число получается делением долей
  // пройденного — «пробег на столько-то процентов впереди времени» и «темп на
  // столько-то процентов выше нормы» здесь одно и то же.
  ratio: number
  // Сколько суток осталось, если ехать так же дальше. Null — шкала стоит на
  // месте и сама по себе не кончится никогда.
  daysLeft: number | null
  // Сколько можно тратить в сутки, чтобы остатка хватило ровно до конца
  // календарного интервала. Null, когда календарь уже вышел.
  allowancePerDay: number | null
}

export interface OilPace {
  // Суток с последней замены — знаменатель всех темпов ниже.
  days: number
  clocks: OilPaceClock[]
  // Шкала, которая при нынешнем темпе кончится первой. Это не обязательно та,
  // что дальше всех прошла: календарь может опережать пробег сегодня и всё
  // равно уступить ему через месяц активной езды.
  binding: OilPaceClock | null
  daysLeft: number | null
  dueAt: Date | null
}

// Где машина окажется, если продолжит в том же духе. `oilLife` отвечает, сколько
// ресурса истрачено, и этого мало для решения: остаток в 4000 км означает и
// «полгода спокойной жизни», и «шесть недель», смотря сколько машина ездит.
export function oilPace(life: OilLife, days: number, now = new Date()): OilPace | null {
  if (!(days >= MIN_PACE_DAYS) || !life.clocks.length) return null

  const calendarDaysLeft = Math.max(0, OIL_INTERVAL_DAYS - days)
  const clocks = life.clocks.map<OilPaceClock>(item => {
    const normPerDay = item.interval / OIL_INTERVAL_DAYS
    const perDay = item.used / days
    return {
      name: item.name,
      perDay,
      normPerDay,
      ratio: perDay / normPerDay,
      daysLeft: perDay > 0 ? item.remaining / perDay : null,
      allowancePerDay: calendarDaysLeft > 0 ? item.remaining / calendarDaysLeft : null
    }
  })

  const binding = clocks.reduce<OilPaceClock | null>((soonest, item) => {
    if (item.daysLeft == null) return soonest
    return !soonest || item.daysLeft < soonest.daysLeft! ? item : soonest
  }, null)

  return {
    days,
    clocks,
    binding,
    daysLeft: binding?.daysLeft ?? null,
    dueAt: binding?.daysLeft == null ? null : new Date(now.getTime() + binding.daysLeft * DAY_MS)
  }
}

// Насколько шкала обгоняет календарь — то же отношение, что и `ratio`, но
// выраженное так, как о нём говорят: 0,49 значит «на 49 % впереди времени»,
// −0,2 — «на 20 % позади».
export function oilPaceExcess(pace: OilPace | null, name: OilClockName) {
  const clock = pace?.clocks.find(item => item.name === name)
  return clock ? clock.ratio - 1 : null
}
