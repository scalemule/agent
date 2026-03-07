export class AgentError extends Error {
  public readonly status: number
  public readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'AgentError'
    this.status = status
    this.body = body
  }
}
