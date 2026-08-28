import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { resolve } from 'node:path'
import { createDatabase } from '../db/client'
import { engineSessions, vehicles, vehicleSnapshots } from '../db/schema'
import { sessionOdometerSpan } from '../metrics/odometer'

// Одометр этой машины целочисленный, отдаёт пробег кусками по десять-двадцать
// километров и досылает остаток уже после того, как зажигание выключили. Кому
// принадлежат досланные километры — единственный вопрос, от которого зависят и
// пробег поездки, и её средняя скорость, и счёт за холостой ход.
describe('к какой сессии относится показание одометра', () => {
  const base = new Date('2026-08-05T09:00:00.000Z')
  const at = (minute: number) => new Date(base.getTime() + minute * 60_000)

  const build = async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const snapshot = async (minute: number, state: {
      ignition?: boolean, armed?: boolean, mileage: number, mileageMinute: number, motorMinutes: number
    }) => {
      await database.insert(vehicleSnapshots).values({
        vehicleId: vehicle!.id,
        ts: at(minute),
        activityTs: at(minute),
        ignition: state.ignition ?? false,
        armed: state.armed ?? !(state.ignition ?? false),
        mileage: state.mileage,
        mileageTs: at(state.mileageMinute),
        motorMinutes: state.motorMinutes,
        rawJson: '{}'
      })
    }
    const session = async (from: number, to: number, mileageStart: number) => {
      const [row] = await database.insert(engineSessions).values({
        vehicleId: vehicle!.id, startedAt: at(from), endedAt: at(to), mileageStart, isOpen: false
      }).returning()
      return row!
    }
    return { database, vehicle: vehicle!, snapshot, session }
  }

  it('отдаёт досылку той дороге, которая её проехала, а не следующей', async () => {
    const { database, snapshot, session } = await build()
    try {
      await snapshot(0, { mileage: 100, mileageMinute: 0, motorMinutes: 500 })
      await snapshot(2, { ignition: true, mileage: 100, mileageMinute: 0, motorMinutes: 502 })
      await snapshot(10, { mileage: 100, mileageMinute: 0, motorMinutes: 510 })
      // Остаток приезжает через две минуты после остановки, помеченный тем
      // моментом, когда двигатель заглушили.
      await snapshot(12, { mileage: 118, mileageMinute: 10, motorMinutes: 510 })
      // А ещё через пять минут машина едет снова, и это уже её километры.
      await snapshot(20, { ignition: true, mileage: 118, mileageMinute: 10, motorMinutes: 518 })
      await snapshot(30, { mileage: 130, mileageMinute: 30, motorMinutes: 528 })

      const first = await session(2, 10, 100)
      await session(20, 30, 118)
      expect(await sessionOdometerSpan(database, first)).toMatchObject({
        mileageStart: 100, mileageEnd: 118, distance: 18
      })
    } finally {
      await database.$client.close()
    }
  })

  it('не отдаёт прогреву на автозапуске ни километра — и он их не задерживает', async () => {
    const { database, snapshot, session } = await build()
    try {
      await snapshot(0, { mileage: 100, mileageMinute: 0, motorMinutes: 500 })
      await snapshot(2, { ignition: true, armed: false, mileage: 100, mileageMinute: 0, motorMinutes: 502 })
      await snapshot(10, { mileage: 100, mileageMinute: 0, motorMinutes: 510 })

      // Наутро машину заводят с брелка: сигнализация не снята, ехать нельзя.
      // OBD просыпается вместе с двигателем и читает одометр заново — теперь он
      // на семь километров больше, чем датчик успел отчитать вчера. Метка у
      // чтения сегодняшняя, так что по времени эти километры не отличить от
      // проеханных: доказывает их чужими только охрана.
      await snapshot(600, { ignition: true, armed: true, mileage: 100, mileageMinute: 0, motorMinutes: 604 })
      await snapshot(604, { ignition: true, armed: true, mileage: 107, mileageMinute: 603, motorMinutes: 608 })
      await snapshot(610, { mileage: 107, mileageMinute: 603, motorMinutes: 612 })
      // И только потом выезжают по-настоящему.
      await snapshot(615, { ignition: true, armed: false, mileage: 107, mileageMinute: 603, motorMinutes: 615 })
      await snapshot(630, { mileage: 120, mileageMinute: 630, motorMinutes: 630 })

      const drive = await session(2, 10, 100)
      const warmup = await session(600, 610, 100)
      const morning = await session(615, 630, 107)

      expect(await sessionOdometerSpan(database, warmup)).toMatchObject({ distance: 0 })
      // Семь километров принадлежат вчерашней дороге: машина докатила их уже
      // после последнего отчёта датчика, а прогрев их проехать не мог.
      expect(await sessionOdometerSpan(database, drive)).toMatchObject({ mileageEnd: 107, distance: 7 })
      expect(await sessionOdometerSpan(database, morning)).toMatchObject({ mileageStart: 107, distance: 13 })
    } finally {
      await database.$client.close()
    }
  })

  it('останавливает окно досылки на поездке, которую опрос проспал целиком', async () => {
    const { database, snapshot, session } = await build()
    try {
      await snapshot(0, { mileage: 100, mileageMinute: 0, motorMinutes: 500 })
      await snapshot(2, { ignition: true, mileage: 100, mileageMinute: 0, motorMinutes: 502 })
      await snapshot(10, { mileage: 110, mileageMinute: 10, motorMinutes: 510 })
      // Машина стоит, опрос идёт редко.
      await snapshot(40, { mileage: 110, mileageMinute: 10, motorMinutes: 510 })
      // За следующие полчаса машина съездила целиком между двумя опросами:
      // счётчик моточасов вырос на тридцать минут, а зажигания не видел никто.
      await snapshot(70, { ignition: true, mileage: 135, mileageMinute: 68, motorMinutes: 540 })
      await snapshot(80, { mileage: 140, mileageMinute: 80, motorMinutes: 550 })

      const first = await session(2, 10, 100)
      await session(70, 80, 135)
      // Двадцать пять километров проспанной поездки — не досылка за первую
      // сессию, и приписывать их ей значит выдать десять минут за сорок.
      expect(await sessionOdometerSpan(database, first)).toMatchObject({ mileageEnd: 110, distance: 10 })
    } finally {
      await database.$client.close()
    }
  })

  it('не путает проспанную поездку с опросом, опоздавшим к запуску на пару минут', async () => {
    const { database, snapshot, session } = await build()
    try {
      await snapshot(0, { mileage: 100, mileageMinute: 0, motorMinutes: 500 })
      await snapshot(2, { ignition: true, mileage: 100, mileageMinute: 0, motorMinutes: 502 })
      await snapshot(10, { mileage: 100, mileageMinute: 0, motorMinutes: 510 })
      await snapshot(40, { mileage: 100, mileageMinute: 0, motorMinutes: 510 })
      // Опрос застал двигатель, работавший уже три минуты: пока машина стоит,
      // её спрашивают редко. Это начало следующей сессии, а не отдельная дорога.
      await snapshot(45, { ignition: true, mileage: 100, mileageMinute: 0, motorMinutes: 513 })
      await snapshot(50, { mileage: 118, mileageMinute: 44, motorMinutes: 518 })

      const first = await session(2, 10, 100)
      await session(45, 50, 100)
      // Восемнадцать километров помечены временем до старта второй сессии,
      // значит они принадлежат первой — три минуты счётчика перед её запуском
      // это она сама, а не отдельная дорога.
      expect(await sessionOdometerSpan(database, first)).toMatchObject({ mileageEnd: 118, distance: 18 })
    } finally {
      await database.$client.close()
    }
  })
})
