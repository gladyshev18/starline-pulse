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
