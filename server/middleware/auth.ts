export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  const isPublic = path === '/login' || path === '/api/login' || path === '/api/health' || path.startsWith('/api/_auth/') || path.startsWith('/_nuxt/') || path === '/favicon.ico'
  if (isPublic) return

  const isProtected = path.startsWith('/api/') || (!path.includes('.') && !path.startsWith('/__'))
  if (!isProtected) return

  try {
    await requireUserSession(event)
  } catch {
    if (path.startsWith('/api/')) throw createError({ statusCode: 401, statusMessage: 'Требуется вход' })
    return sendRedirect(event, '/login', 302)
  }
})
