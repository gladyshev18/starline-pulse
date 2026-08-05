import { and, desc, eq, gte, sql } from 'drizzle-orm'
import type { Context } from 'grammy'
import type { Database } from '../../db/client'
import { trips, vehicleSnapshots } from '../../db/schema'

const number = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1)
const date = (value: Date) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(value)

export function registerCommands(bot: import('grammy').Bot, database: Database) {
  bot.command('status', async (context: Context) => {
    const vehicle = await database.query.vehicles.findFirst()
    if (!vehicle) return context.reply('Данных об автомобиле пока нет.')
    const snapshot = await database.query.vehicleSnapshots.findFirst({ where: eq(vehicleSnapshots.vehicleId, vehicle.id), orderBy: desc(vehicleSnapshots.ts) })
    if (!snapshot) return context.reply('Снимков состояния пока нет.')
    return context.reply(`${vehicle.alias}\nЗажигание: ${snapshot.ignition ? 'включено' : 'выключено'}\nПробег: ${number(snapshot.mileage)} км\nТопливо: ${number(snapshot.fuel)} л\nПоследняя связь: ${date(snapshot.activityTs || snapshot.ts)}`)
  })

  bot.command('last', async (context: Context) => {
    const vehicle = await database.query.vehicles.findFirst()
    if (!vehicle) return context.reply('Поездок пока нет.')
    const items = await database.select().from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false))).orderBy(desc(trips.startedAt)).limit(5)
    if (!items.length) return context.reply('Поездок пока нет.')
    return context.reply(items.map(item => `${date(item.startedAt)} — ${number(item.distance)} км, ${number(item.fuelUsed)} л`).join('\n'))
  })

  bot.command('month', async (context: Context) => {
    const vehicle = await database.query.vehicles.findFirst()
    if (!vehicle) return context.reply('Данных за месяц пока нет.')
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0)
    const [result] = await database.select({ distance: sql<number>`coalesce(sum(${trips.distance}), 0)`, fuel: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)` })
      .from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false), gte(trips.startedAt, start)))
    const distance = Number(result?.distance || 0), fuel = Number(result?.fuel || 0)
    return context.reply(`Текущий месяц\nПробег: ${number(distance)} км\nТопливо: ${number(fuel)} л\nСредний расход: ${number(distance > 0 ? fuel / distance * 100 : null)} л/100 км`)
  })
}
