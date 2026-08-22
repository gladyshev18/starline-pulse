import { asc } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { telegramRecipients } from '../../db/schema'
import { config } from '../config'

export type Recipient = typeof telegramRecipients.$inferSelect

// The database stores discovered chat IDs, while the environment remains the
// source of truth for who is currently allowed to receive notifications. Sorted
// by id so buttons built from this list keep their order between messages.
export async function allowedRecipients(database: Database) {
  const recipients = await database.select().from(telegramRecipients).orderBy(asc(telegramRecipients.id))
  return recipients.filter(recipient => config.telegramAllowedUsernames.has(recipient.username))
}

// Telegram отдаёт имя не всегда — тогда остаётся логин, он всё равно узнаваем.
export function recipientName(recipient: Pick<Recipient, 'username' | 'firstName'>) {
  return recipient.firstName?.trim() || recipient.username.replace(/^@/, '')
}
