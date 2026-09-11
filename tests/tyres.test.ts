import { migrate } from 'drizzle-orm/libsql/migrator'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { vehicles, vehicleSnapshots } from '../db/schema'
import { dailyAmbient } from '../metrics/tyres'
import {
  ambientFromEngine,
  MARGIN_CELSIUS,
  nightAmbientFromEngine,
  SUSTAINED_DAYS,
  SWITCH_CELSIUS,
  tyreEdgeNote,
  tyreSeason,
  tyreVerdict,
  tyreWatch,
  type AmbientDay
} from '../shared/tyres'
import { buildTyreNotice, nextTyreWatchRun, tyreNotice } from '../worker/bot/tyre-watch'

const DAY_MS = 24 * 60 * 60_000

// Ряд суток, заканчивающийся `lastDay`: сутки задаются средней, а ночь и день
// отступают от неё на заданный размах, если не сказано иначе.
function series(lastDay: string, means: number[], options: { swing?: number, night?: number[] } = {}): AmbientDay[] {
  const swing = options.swing ?? 4
  const end = Date.parse(`${lastDay}T12:00:00+03:00`)
  return means.map((mean, index) => ({
    day: new Date(end - (means.length - 1 - index) * DAY_MS).toISOString().slice(0, 10),
    mean,
    night: options.night?.[index] ?? mean - swing,
    hours: 20
  }))
}

const autumnNoon = new Date('2026-10-05T09:00:00.000Z')
const springNoon = new Date('2026-04-05T09:00:00.000Z')

describe('ambient temperature from the engine sensor', () => {
  it('leaves cold readings alone and shaves the sun off warm ones', () => {
    expect(ambientFromEngine(0)).toBe(0)
    expect(ambientFromEngine(5)).toBe(5)
    // Поправка включается там, где прямая опускается ниже самого датчика.
    expect(ambientFromEngine(20)).toBeCloseTo(17.6, 5)
    expect(ambientFromEngine(30)).toBeCloseTo(25.1, 5)
  })

  it('never claims the iron is colder than the air around it', () => {
    for (const engine of [-25, -10, -1, 0, 9, 10.4]) {
      expect(ambientFromEngine(engine)).toBeCloseTo(engine, 5)
    }
  })
})

describe('which change is ahead', () => {
  it('watches for winter from August through January and for summer the rest of the year', () => {
    expect(tyreSeason(new Date('2026-08-01T00:00:00.000Z'))).toBe('winter')
    expect(tyreSeason(new Date('2026-10-15T00:00:00.000Z'))).toBe('winter')
    expect(tyreSeason(new Date('2027-01-20T00:00:00.000Z'))).toBe('winter')
    expect(tyreSeason(new Date('2027-02-01T00:00:00.000Z'))).toBe('summer')
    expect(tyreSeason(new Date('2027-04-10T00:00:00.000Z'))).toBe('summer')
    expect(tyreSeason(new Date('2027-07-31T00:00:00.000Z'))).toBe('summer')
  })
})

describe('autumn watch', () => {
  it('stays quiet while both the average and the nights are summer', () => {
    const watch = tyreWatch(series('2026-10-05', [20, 19, 20, 21, 20]), autumnNoon)
    expect(watch.season).toBe('winter')
    expect(watch.status).toBe('far')
    expect(watch.edge).toBeNull()
  })

  it('warns about the nights while the daily average still holds above the margin', () => {
    // Средняя +14, а под утро +3: до шиномонтажа далеко, но ночью дорога уже
    // зимняя — ровно тот промежуток, ради которого статус и заведён.
    const watch = tyreWatch(series('2026-10-05', [15, 14, 14, 14, 14], { night: [6, 5, 4, 3, 3] }), autumnNoon)
    expect(watch.status).toBe('edge')
    expect(watch.sustained).toBeCloseTo(14, 5)
    expect(watch.edge).toEqual({ nights: 5, coldest: 3 })
    expect(tyreVerdict(watch)).toBe('Менять рано, но ночью дорога уже зимняя')
    expect(tyreEdgeNote(watch)).toContain('Ночью и ранним утром')
  })

  it('asks to book a fitter once the average enters the margin', () => {
    const watch = tyreWatch(series('2026-10-05', [14, 13, 11, 10, 10]), autumnNoon)
    expect(watch.status).toBe('soon')
    expect(watch.sustained).toBeLessThanOrEqual(SWITCH_CELSIUS + MARGIN_CELSIUS)
    expect(watch.sustained).toBeGreaterThan(SWITCH_CELSIUS)
  })

  it('calls the change once the average holds below the threshold', () => {
    const watch = tyreWatch(series('2026-10-05', [10, 9, 7, 6, 6]), autumnNoon)
    expect(watch.status).toBe('now')
    expect(tyreVerdict(watch)).toBe('Пора менять на зимнюю')
    // Вердикт уже сказал «менять» — примечание про часы больше ничего не добавляет.
    expect(tyreEdgeNote(watch)).toBeNull()
  })

  it('calls the change on the first frost even when the average is still mild', () => {
    const watch = tyreWatch(series('2026-10-05', [11, 10, 10, 10, 10], { night: [5, 4, 2, 0, -2] }), autumnNoon)
    expect(watch.sustained).toBeGreaterThan(SWITCH_CELSIUS)
    expect(watch.frostNights).toBe(1)
    expect(watch.status).toBe('now')
  })

  it('has nothing left to advise once the average is below zero', () => {
    const watch = tyreWatch(series('2026-10-05', [3, 2, 0, -1, -2]), autumnNoon)
    expect(watch.status).toBe('late')
  })

  it('predicts the day the threshold is crossed from the fortnight behind it', () => {
    // Ровно один градус в сутки вниз, последние сутки на +12: до +7 пять суток.
    const watch = tyreWatch(series('2026-10-05', [17, 16, 15, 14, 13, 12]), autumnNoon)
    expect(watch.perDay).toBeCloseTo(-1, 5)
    expect(watch.daysToCrossing).toBe(5)
    expect(watch.crossingAt?.toISOString().slice(0, 10)).toBe('2026-10-10')
  })

  it('offers no date while the weather warms against the season', () => {
    const watch = tyreWatch(series('2026-10-05', [10, 11, 12, 13, 14, 15]), autumnNoon)
    expect(watch.perDay).toBeGreaterThan(0)
    expect(watch.crossingAt).toBeNull()
  })
})

describe('spring watch', () => {
  it('has no edge of its own: the frost speaks for the spring', () => {
    const watch = tyreWatch(series('2026-04-05', [1, 1, 1, 1, 1], { night: [-4, -4, -3, -3, -3] }), springNoon)
    expect(watch.season).toBe('summer')
    expect(watch.edge).toBeNull()
    expect(watch.status).toBe('far')
    expect(tyreEdgeNote(watch)).toBeNull()
  })

  it('holds the winter tyres while the nights still freeze', () => {
    const watch = tyreWatch(series('2026-04-05', [8, 9, 9, 10, 10], { night: [0, -1, 1, 2, 2] }), springNoon)
    expect(watch.sustained).toBeGreaterThanOrEqual(SWITCH_CELSIUS)
    expect(watch.frostNights).toBe(1)
    expect(watch.status).toBe('soon')
  })

  it('lets the summer tyres on after a week without frost', () => {
    const watch = tyreWatch(series('2026-04-05', [7, 8, 9, 10, 10, 11, 11], { swing: 3 }), springNoon)
    expect(watch.frostNights).toBe(0)
    expect(watch.status).toBe('now')
    expect(tyreVerdict(watch)).toBe('Пора менять на летнюю')
  })

  it('says the change was overdue once the average is properly warm', () => {
    const watch = tyreWatch(series('2026-04-05', [13, 14, 15, 16, 17], { swing: 3 }), springNoon)
    expect(watch.status).toBe('late')
  })
})

describe('when the weather is not enough to judge', () => {
  it('needs three days in a row', () => {
    expect(tyreWatch(series('2026-10-05', [8, 8]), autumnNoon).status).toBe('unknown')
    expect(tyreWatch([], autumnNoon).status).toBe('unknown')
  })

  it('refuses to decide today from a series that ended last week', () => {
    const watch = tyreWatch(series('2026-09-25', [8, 7, 6, 6, 6]), autumnNoon)
    expect(watch.days).toBe(5)
    expect(watch.status).toBe('unknown')
    expect(watch.sustained).toBeNull()
  })
})

// Сутки в снапшотах: машина стоит, датчик двигателя каждый час показывает
// заданную температуру. Этого хватает, чтобы пройти и отсев по часам, и
// поправку — а она на холоде тождественна, поэтому число доезжает до вердикта
// таким, каким записано.
async function parkedDays(database: ReturnType<typeof createDatabase>, vehicleId: number, lastDay: string, engineByDay: number[]) {
  const end = Date.parse(`${lastDay}T00:00:00+03:00`)
  const rows = []
  for (const [index, engine] of engineByDay.entries()) {
    const dayStart = end - (engineByDay.length - 1 - index) * DAY_MS
    for (let hour = 0; hour < 24; hour++) {
      rows.push({
        vehicleId,
        ts: new Date(dayStart + hour * 60 * 60_000),
        ignition: false,
        engineTemp: engine,
        rawJson: '{}'
      })
    }
  }
  await database.insert(vehicleSnapshots).values(rows)
}

async function seed(lastDay: string, engineByDay: number[]) {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  await parkedDays(database, vehicle!.id, lastDay, engineByDay)
  return { database, vehicleId: vehicle!.id }
}

describe('daily ambient from snapshots', () => {
  it('averages the day by hours and keeps the night and the afternoon apart', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const dayStart = Date.parse('2026-10-04T00:00:00+03:00')
    // Ночью 0, днём 12 — средняя по часам ровно шесть, как бы часто ни
    // опрашивали машину ночью.
    const rows = []
    for (let hour = 0; hour < 24; hour++) {
      const engine = hour < 12 ? 0 : 12
      const samples = hour < 12 ? 6 : 1
      for (let sample = 0; sample < samples; sample++) {
        rows.push({
          vehicleId: vehicle!.id,
          ts: new Date(dayStart + hour * 60 * 60_000 + sample * 9 * 60_000),
          ignition: false,
          engineTemp: engine,
          rawJson: '{}'
        })
      }
    }
    await database.insert(vehicleSnapshots).values(rows)

    try {
      const [day] = await dailyAmbient(database, vehicle!.id, new Date('2026-10-01'), new Date('2026-10-06'))
      expect(day?.day).toBe('2026-10-04')
      expect(day?.mean).toBeCloseTo(6, 5)
      expect(day?.night).toBeCloseTo(nightAmbientFromEngine(0), 5)
      expect(day?.hours).toBe(24)
    } finally {
      await database.$client.close()
    }
  })

  it('drops the hours when the engine was still warm from running', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const dayStart = Date.parse('2026-10-04T00:00:00+03:00')
    const rows = []
    for (let hour = 0; hour < 24; hour++) {
      // В восемь утра машина завелась: этот час и два следующих показывают
      // горячий двигатель, а не воздух.
      const running = hour === 8
      rows.push({
        vehicleId: vehicle!.id,
        ts: new Date(dayStart + hour * 60 * 60_000),
        ignition: running,
        engineTemp: hour >= 8 && hour <= 10 ? 85 : 5,
        rawJson: '{}'
      })
    }
    await database.insert(vehicleSnapshots).values(rows)

    try {
      const [day] = await dailyAmbient(database, vehicle!.id, new Date('2026-10-01'), new Date('2026-10-06'))
      expect(day?.hours).toBe(21)
      expect(day?.mean).toBeCloseTo(5, 5)
      expect(day?.night).toBeCloseTo(5, 5)
    } finally {
      await database.$client.close()
    }
  })
})

describe('what the notice says', () => {
  const previous = { season: null, status: null }

  it('says nothing while the change is far off', () => {
    expect(tyreNotice(tyreWatch(series('2026-10-05', [20, 20, 20]), autumnNoon), previous)).toBeNull()
  })

  it('says nothing without enough weather to judge', () => {
    expect(tyreNotice(tyreWatch(series('2026-10-05', [6, 6]), autumnNoon), previous)).toBeNull()
    expect(tyreNotice(tyreWatch([], autumnNoon), previous)).toBeNull()
  })

  it('warns about the nights before it asks for the change', () => {
    const watch = tyreWatch(series('2026-10-05', [15, 14, 14, 14], { night: [6, 5, 4, 4] }), autumnNoon)
    const notice = tyreNotice(watch, previous)
    expect(notice?.status).toBe('edge')
    expect(notice?.text).toContain('Ночью уже зима')
    expect(notice?.text).toContain('переобуваться рано')
    expect(notice?.text).toContain('Ночью и ранним утром')
  })

  it('asks to book a fitter and names the day the threshold falls', () => {
    const watch = tyreWatch(series('2026-10-05', [16, 15, 14, 13, 12, 11]), autumnNoon)
    const notice = tyreNotice(watch, previous)
    expect(notice?.status).toBe('soon')
    expect(notice?.text).toContain('Скоро на зимнюю')
    expect(notice?.text).toContain('шиномонтаж')
    expect(notice?.text).toContain('холодает на 1,0 °C в сутки')
    expect(notice?.text).toContain('9 октября')
  })

  it('speaks once about a status and stays quiet on the next morning', () => {
    const watch = tyreWatch(series('2026-10-05', [14, 13, 11, 10, 10]), autumnNoon)
    expect(tyreNotice(watch, previous)?.status).toBe('soon')
    expect(tyreNotice(watch, { season: 'winter', status: 'soon' })).toBeNull()
    // Отступившее похолодание не отменяет уже сказанного «пора».
    expect(tyreNotice(watch, { season: 'winter', status: 'now' })).toBeNull()
  })

  it('speaks again when the weather escalates', () => {
    const watch = tyreWatch(series('2026-10-05', [10, 9, 7, 6, 6]), autumnNoon)
    const notice = tyreNotice(watch, { season: 'winter', status: 'soon' })
    expect(notice?.status).toBe('now')
    expect(notice?.text).toContain('Пора на зимнюю')
  })

  it('starts the ladder over when the season turns', () => {
    const watch = tyreWatch(series('2026-04-05', [7, 8, 9, 10, 10, 11, 11], { swing: 3 }), springNoon)
    // Осенью уже говорили «пора на зимнюю» — весной это не повод молчать.
    const notice = tyreNotice(watch, { season: 'winter', status: 'late' })
    expect(notice?.season).toBe('summer')
    expect(notice?.status).toBe('now')
    expect(notice?.text).toContain('Пора на летнюю')
  })

  it('holds the spring change back while the nights still freeze', () => {
    const watch = tyreWatch(series('2026-04-05', [8, 9, 9, 10, 10], { night: [0, -1, 1, 2, 2] }), springNoon)
    const notice = tyreNotice(watch, previous)
    expect(notice?.status).toBe('soon')
    expect(notice?.text).toContain('ниже нуля')
    expect(notice?.text).toContain('переобуваться рано')
  })
})

describe('the notice against the database', () => {
  it('runs every day at 10:00 Moscow time', () => {
    expect(nextTyreWatchRun(new Date('2026-10-05T06:00:00.000Z')).toISOString()).toBe('2026-10-05T07:00:00.000Z')
    expect(nextTyreWatchRun(new Date('2026-10-05T08:00:00.000Z')).toISOString()).toBe('2026-10-06T07:00:00.000Z')
  })

  it('reads the weather out of the snapshots and speaks', async () => {
    const { database } = await seed('2026-10-04', [11, 10, 9, 9])
    try {
      const notice = await buildTyreNotice(database, { season: null, status: null }, autumnNoon)
      expect(notice?.status).toBe('soon')
      expect(notice?.text).toContain('Скоро на зимнюю')
      await expect(buildTyreNotice(database, { season: 'winter', status: 'soon' }, autumnNoon)).resolves.toBeNull()
    } finally {
      await database.$client.close()
    }
  })

  it('stays quiet while the car reports summer', async () => {
    const { database } = await seed('2026-10-04', [20, 20, 20, 20])
    try {
      await expect(buildTyreNotice(database, { season: null, status: null }, autumnNoon)).resolves.toBeNull()
    } finally {
      await database.$client.close()
    }
  })

  it('says nothing at all without a car', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    try {
      await expect(buildTyreNotice(database, { season: null, status: null }, autumnNoon)).resolves.toBeNull()
    } finally {
      await database.$client.close()
    }
  })
})

describe('the sustained average', () => {
  it('is taken over the last three days, not the whole series', () => {
    const watch = tyreWatch(series('2026-10-05', [20, 20, 20, 6, 6, 6]), autumnNoon)
    expect(watch.days).toBe(6)
    expect(watch.sustained).toBeCloseTo(6, 5)
    expect(SUSTAINED_DAYS).toBe(3)
  })
})
