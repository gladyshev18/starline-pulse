import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const recordFailure = assertLoginRateLimit(event)
  const body = await readBody<{ login?: string, password?: string }>(event)
  const login = body.login?.trim().toLowerCase()
  if (!login || !body.password) throw createError({ statusCode: 400, statusMessage: 'Введите логин и пароль' })

  const user = await useAppDatabase().query.users.findFirst({ where: eq(users.login, login) })
  if (!user || !await argon2.verify(user.passwordHash, body.password)) {
    recordFailure()
    throw createError({ statusCode: 401, statusMessage: 'Неверный логин или пароль' })
  }

  await setUserSession(event, {
    user: { id: user.id, login: user.login, displayName: user.displayName },
    loggedInAt: Date.now()
  }, { maxAge: 60 * 60 * 24 * 30 })
  return { ok: true }
})
