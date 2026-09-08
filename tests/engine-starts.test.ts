import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { deviceEvents, vehicleSnapshots, vehicles } from '../db/schema'
import { startHealth } from '../metrics/engine-starts'
import { summariseStarts, type StartSample } from '../shared/engine-starts'
import { ENGINE_CRANKING, ENGINE_STARTED, ENGINE_STOPPED } from '../shared/starline-events'

const now = new Date('2026-03-15T12:00:00.000Z')

function sample(at: string, volts: number | null, extra: Partial<StartSample> = {}): StartSample {
  return {
    at: new Date(at),
    remote: false,
    restVolts: volts,
    restedHours: 12,
    engineTemp: 5,
    crankSeconds: null,
    ...extra
  }
}

describe('summariseStarts', () => {
  it('считает напряжение только по пускам после долгой стоянки', () => {
    const health = summariseStarts([
      sample('2026-01-05T06:00:00.000Z', 12.7),
      // Пуск через полчаса после поездки: на клеммах ещё поверхностный заряд.
      sample('2026-01-05T09:00:00.000Z', 12.9, { restedHours: 0.5 }),
      sample('2026-01-06T06:00:00.000Z', 12.5)
    ])
    expect(health.starts).toBe(3)
    expect(health.voltage.samples).toBe(2)
    expect(health.voltage.average).toBeCloseTo(12.6)
    expect(health.voltage.lowest).toBeCloseTo(12.5)
  })

  it('пересчитывает пуски по тому, был ли это автозапуск', () => {
    const health = summariseStarts([
      sample('2026-01-05T06:00:00.000Z', 12.7, { remote: true, crankSeconds: 8 }),
      sample('2026-01-05T18:00:00.000Z', 12.6),
      sample('2026-01-06T06:00:00.000Z', 12.6, { remote: true, crankSeconds: 2 })
    ])
    expect(health.remote).toBe(2)
    expect(health.manual).toBe(1)
    expect(health.crank.samples).toBe(2)
    expect(health.crank.seconds).toBe(5)
  })

  it('считает севшие пуски и молчит о наклоне, пока он тонет в разбросе', () => {
    const health = summariseStarts([
      sample('2026-01-05T06:00:00.000Z', 12.8),
      sample('2026-01-10T06:00:00.000Z', 12.3),
      sample('2026-01-15T06:00:00.000Z', 12.9),
      sample('2026-01-20T06:00:00.000Z', 11.9)
    ])
    expect(health.voltage.low).toBe(2)
    expect(health.voltage.critical).toBe(1)
    expect(health.voltage.perMonth).toBeNull()
  })

  it('называет темп падения, когда напряжение уезжает ровно', () => {
    const health = summariseStarts([
      sample('2026-01-01T06:00:00.000Z', 12.8),
      sample('2026-01-11T06:00:00.000Z', 12.7),
      sample('2026-01-21T06:00:00.000Z', 12.6),
      sample('2026-01-31T06:00:00.000Z', 12.5)
    ])
    expect(health.voltage.perMonth).toBeCloseTo(-0.3, 1)
  })

  it('на пустой истории отдаёт нули, а не прочерки в неожиданных местах', () => {
    const health = summariseStarts([])
    expect(health.starts).toBe(0)
    expect(health.voltage.average).toBeNull()
    expect(health.crank.seconds).toBeNull()
  })
})

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicleId: vehicle!.id }
}

describe('startHealth', () => {
  it('берёт напряжение из последнего снимка перед пуском и длину стоянки из остановки', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(deviceEvents).values([
      { vehicleId, type: ENGINE_STARTED, ts: new Date('2026-03-01T06:00:00.000Z') },
      { vehicleId, type: ENGINE_STOPPED, ts: new Date('2026-03-01T06:30:00.000Z') },
      // Автозапуск: «начал заводиться» за восемь секунд до «запущен».
      { vehicleId, type: ENGINE_CRANKING, ts: new Date('2026-03-02T06:00:00.000Z') },
      { vehicleId, type: ENGINE_STARTED, ts: new Date('2026-03-02T06:00:08.000Z') }
    ])
    await database.insert(vehicleSnapshots).values([
      // Свежий замер перед вторым пуском.
      { vehicleId, ts: new Date('2026-03-02T05:55:00.000Z'), battery: 12.6, batteryType: 'volt', ignition: false, engineTemp: 3, rawJson: '{}' },
      // Показание на заведённой машине в счёт не идёт: это генератор.
      { vehicleId, ts: new Date('2026-03-02T06:10:00.000Z'), battery: 14.5, batteryType: 'volt', ignition: true, engineTemp: 60, rawJson: '{}' }
    ])

    const health = await startHealth(database, vehicleId, new Date('2026-01-01T00:00:00.000Z'), now)
    expect(health.starts).toBe(2)
    expect(health.remote).toBe(1)
    expect(health.crank.seconds).toBe(8)
    // Первый пуск остался без напряжения — снимков до него нет; второй попал в
    // выборку целиком, потому что машина простояла с вечера.
    expect(health.voltage.samples).toBe(1)
    expect(health.voltage.average).toBeCloseTo(12.6)
  })

  it('не берёт напряжение из показания часовой давности', async () => {
    const { database, vehicleId } = await setup()
    await database.insert(deviceEvents).values([
      { vehicleId, type: ENGINE_STOPPED, ts: new Date('2026-03-01T18:00:00.000Z') },
      { vehicleId, type: ENGINE_STARTED, ts: new Date('2026-03-02T06:00:00.000Z') }
    ])
    await database.insert(vehicleSnapshots).values([
      { vehicleId, ts: new Date('2026-03-02T03:00:00.000Z'), battery: 12.6, batteryType: 'volt', ignition: false, rawJson: '{}' }
    ])

    const health = await startHealth(database, vehicleId, new Date('2026-01-01T00:00:00.000Z'), now)
    expect(health.starts).toBe(1)
    expect(health.voltage.samples).toBe(0)
  })
})
