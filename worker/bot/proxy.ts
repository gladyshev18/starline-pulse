import { fetch as undiciFetch, ProxyAgent } from 'undici'

let proxyAgent: ProxyAgent | null = null

export function createTelegramProxyFetch(proxyUrl: string) {
  proxyAgent = new ProxyAgent(proxyUrl)
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher: proxyAgent! } as Parameters<typeof undiciFetch>[1]
    )
  }) as unknown as typeof fetch
}

export async function closeTelegramProxy() {
  const agent = proxyAgent
  proxyAgent = null
  if (agent) await agent.close()
}
