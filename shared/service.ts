// Oil does not wear out by distance. It wears out by how long the engine has
// been turning, by how hot it got, and by how long it has been sitting in the
// sump oxidising. The manual states the interval in kilometres only because a
// car has an odometer and no one reads engine hours — but this car has one, and
// it disagrees with the odometer precisely when it matters: an hour spent
// warming up or crawling in traffic ages the oil exactly as much as an hour on
// the motorway, and adds a twentieth of the kilometres.
export const OIL_INTERVAL_KM = 10_000
export const OIL_INTERVAL_MONTHS = 12

// The kilometre interval quietly assumes a speed — the manual's ten thousand are
// ten thousand kilometres of ordinary driving, not of standing still. Thirty
// km/h is the equivalence behind the usual "one engine-hour is about thirty
// kilometres" rule, and it is what turns a distance interval into a time one.
// Raising it lengthens the engine-hour interval, so it is the single number to
// tune if the manual gives engine hours outright.
export const OIL_REFERENCE_SPEED_KMH = 30
export const OIL_INTERVAL_MOTOR_HOURS = OIL_INTERVAL_KM / OIL_REFERENCE_SPEED_KMH

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
// OIL_REFERENCE_SPEED_KMH it says in one number whether its life is motorway or
// traffic — and it is the honest way to check the assumption above rather than
// taking the rule of thumb on faith.
export function kmPerMotorHour(km: number | null, motorHours: number | null) {
  if (km == null || motorHours == null || !(motorHours > 0)) return null
  return km / motorHours
}
