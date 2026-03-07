import { AgentError } from './errors'
import type { TokenExchangeResult, SignRequestFn } from './types'

export class AuthManager {
  private accessToken: string | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private readonly agentToken: string
  private readonly apiKey: string
  private readonly refreshSecret: string | null
  private readonly gatewayUrl: string
  private readonly signRequest: SignRequestFn | null

  constructor(
    agentToken: string,
    apiKey: string,
    gatewayUrl: string,
    refreshSecret?: string,
    signRequest?: SignRequestFn,
  ) {
    this.agentToken = agentToken
    this.apiKey = apiKey
    this.gatewayUrl = gatewayUrl
    this.refreshSecret = refreshSecret ?? null
    this.signRequest = signRequest ?? null
  }

  get useJwtMode(): boolean {
    return this.refreshSecret !== null
  }

  getAuthHeader(): string {
    if (this.accessToken) {
      return `Bearer ${this.accessToken}`
    }
    return `Bearer ${this.agentToken}`
  }

  async initialize(): Promise<void> {
    if (!this.useJwtMode) return
    await this.exchangeToken()
  }

  async exchangeToken(): Promise<void> {
    if (!this.refreshSecret) {
      throw new AgentError(0, 'Cannot exchange token without refreshSecret')
    }

    const path = '/v1/auth/agent-tokens/exchange'
    const body = JSON.stringify({ refresh_secret: this.refreshSecret })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.agentToken}`,
      'x-api-key': this.apiKey,
    }

    // Sign the exchange request if the app requires request signing
    if (this.signRequest) {
      this.signRequest(headers, 'POST', path, body)
    }

    const res = await fetch(`${this.gatewayUrl}${path}`, {
      method: 'POST',
      headers,
      body,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new AgentError(res.status, `Token exchange failed: ${res.statusText}`, text)
    }

    const json = await res.json() as { data: TokenExchangeResult }
    const result = json.data
    this.accessToken = result.access_token

    // Schedule refresh at TTL - 60s
    const refreshMs = Math.max((result.expires_in - 60) * 1000, 5000)
    this.scheduleRefresh(refreshMs)
  }

  private scheduleRefresh(ms: number): void {
    this.clearRefreshTimer()
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.exchangeToken()
      } catch {
        // Retry once after 5s
        this.refreshTimer = setTimeout(async () => {
          try {
            await this.exchangeToken()
          } catch {
            // Auth will fail on next request
          }
        }, 5000)
      }
    }, ms)
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  destroy(): void {
    this.clearRefreshTimer()
    this.accessToken = null
  }
}
