import { fetch as undiciFetch, ProxyAgent } from 'undici'

let proxyAgent: ProxyAgent | null = null

export function createTelegramProxyFetch(proxyUrl: string) {
  proxyAgent = new ProxyAgent(proxyUrl)
  return telegramFetch
}

// File downloads go to a different Telegram host than the Bot API, and must take
// the same proxy route as the API calls do.
export const telegramFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    (proxyAgent ? { ...init, dispatcher: proxyAgent } : init) as Parameters<typeof undiciFetch>[1]
  )
}) as unknown as typeof fetch

export async function closeTelegramProxy() {
  const agent = proxyAgent
  proxyAgent = null
  if (agent) await agent.close()
}
