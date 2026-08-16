import { desc, eq, inArray, or } from 'drizzle-orm'
import { refuelEvents, refuelReceipts } from '../../../db/schema'

const filters = ['all', 'pending', 'linked'] as const
type Filter = (typeof filters)[number]

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const requested = String(query.status || 'pending')
  const filter: Filter = filters.includes(requested as Filter) ? requested as Filter : 'pending'

  const database = useAppDatabase()
  const where = filter === 'pending'
    ? or(eq(refuelReceipts.matchStatus, 'unmatched'), eq(refuelReceipts.matchStatus, 'suggested'))
    : filter === 'linked'
      ? or(eq(refuelReceipts.matchStatus, 'auto'), eq(refuelReceipts.matchStatus, 'manual'))
      : undefined

  const items = await database.select().from(refuelReceipts)
    .where(where)
    .orderBy(desc(refuelReceipts.purchasedAt), desc(refuelReceipts.createdAt))
    .limit(200)

  const eventIds = [...new Set(items.flatMap(item => [item.refuelEventId, item.suggestedRefuelEventId])
    .filter((id): id is number => id != null))]
  const events = eventIds.length
    ? await database.select().from(refuelEvents).where(inArray(refuelEvents.id, eventIds))
    : []
  const eventById = new Map(events.map(refuel => [refuel.id, refuel]))

  return {
    items: items.map(receipt => ({
      ...receipt,
      refuel: receipt.refuelEventId != null ? eventById.get(receipt.refuelEventId) || null : null,
      suggestedRefuel: receipt.suggestedRefuelEventId != null ? eventById.get(receipt.suggestedRefuelEventId) || null : null
    }))
  }
})
