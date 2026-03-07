import { createHash, randomUUID, sign, createPrivateKey } from 'node:crypto'
import { AuthManager } from './auth'
import { AgentError } from './errors'
import { HeartbeatManager } from './heartbeat'
import type {
  ScaleMuleAgentConfig,
  ClaimResult,
  SubmitResult,
  Task,
  TaskTransition,
  ProjectDocument,
  TaskContext,
  SubmitOptions,
  BlockOptions,
  SignRequestFn,
} from './types'

export class ScaleMuleAgent {
  private readonly config: {
    apiKey: string
    agentToken: string
    agentId: string
    gatewayUrl: string
    signingKeyId: string | null
    signingPrivateKey: string | null
  }
  private readonly auth: AuthManager
  private readonly heartbeat: HeartbeatManager

  constructor(config: ScaleMuleAgentConfig) {
    if (!config.apiKey) throw new Error('apiKey is required')
    if (!config.agentToken) throw new Error('agentToken is required')
    if (!config.agentId) throw new Error('agentId is required')

    if ((config.signingKeyId && !config.signingPrivateKey) || (!config.signingKeyId && config.signingPrivateKey)) {
      throw new Error('Both signingKeyId and signingPrivateKey must be provided together')
    }

    this.config = {
      apiKey: config.apiKey,
      agentToken: config.agentToken,
      agentId: config.agentId,
      gatewayUrl: config.gatewayUrl ?? 'https://api.scalemule.com',
      signingKeyId: config.signingKeyId ?? null,
      signingPrivateKey: config.signingPrivateKey ?? null,
    }

    // Build signing callback for AuthManager (used on token exchange requests)
    const signFn: SignRequestFn | undefined =
      this.config.signingKeyId && this.config.signingPrivateKey
        ? (headers, method, path, body) => this.addSignatureHeaders(headers, method, path, body)
        : undefined

    this.auth = new AuthManager(
      config.agentToken,
      config.apiKey,
      this.config.gatewayUrl,
      config.refreshSecret,
      signFn,
    )
    this.heartbeat = new HeartbeatManager()
  }

  get events(): HeartbeatManager {
    return this.heartbeat
  }

  async connect(): Promise<void> {
    await this.auth.initialize()
  }

  async disconnect(): Promise<void> {
    this.heartbeat.stop()
    this.auth.destroy()
  }

  // =========================================================================
  // Task Lifecycle
  // =========================================================================

  async claimNext(): Promise<ClaimResult | null> {
    const result = await this.request<ClaimResult | null>(
      'POST',
      '/v1/agent-projects/tasks/next-available',
      { agent_id: this.config.agentId },
    )
    if (result === null) return null
    await this.transitionToInProgress(result.task_id)
    this.heartbeat.start(result.task_id, result.lease_expires_at, (taskId) => this.sendHeartbeat(taskId))
    return result
  }

  async claim(taskId: string): Promise<ClaimResult> {
    const result = await this.request<ClaimResult>(
      'POST',
      `/v1/agent-projects/tasks/${taskId}/claim`,
      { agent_id: this.config.agentId },
    )
    await this.transitionToInProgress(taskId)
    this.heartbeat.start(taskId, result.lease_expires_at, (tid) => this.sendHeartbeat(tid))
    return result
  }

  async submit(taskId: string, options: SubmitOptions = {}): Promise<SubmitResult> {
    this.heartbeat.stop()
    return this.request<SubmitResult>(
      'POST',
      `/v1/agent-projects/tasks/${taskId}/submit`,
      {
        agent_id: this.config.agentId,
        idempotency_key: options.idempotencyKey ?? randomUUID(),
        output: options.output,
        input_tokens: options.inputTokens,
        output_tokens: options.outputTokens,
        cost_usd: options.costUsd,
        notes: options.notes,
      },
    )
  }

  async block(taskId: string, options: BlockOptions): Promise<Task> {
    this.heartbeat.stop()
    return this.request<Task>(
      'POST',
      `/v1/agent-projects/tasks/${taskId}/block`,
      {
        agent_id: this.config.agentId,
        reason: options.reason,
        question: options.question,
      },
    )
  }

  // =========================================================================
  // Task Queries
  // =========================================================================

  async getTask(taskId: string): Promise<Task> {
    return this.request<Task>('GET', `/v1/agent-projects/tasks/${taskId}`)
  }

  async listTransitions(taskId: string): Promise<TaskTransition[]> {
    const result = await this.request<{ transitions: TaskTransition[] }>(
      'GET', `/v1/agent-projects/tasks/${taskId}/transitions`,
    )
    return result.transitions
  }

  async listDocuments(projectId: string): Promise<ProjectDocument[]> {
    const result = await this.request<{ documents: ProjectDocument[] }>(
      'GET', `/v1/agent-projects/projects/${projectId}/documents`,
    )
    return result.documents
  }

  async getTaskContext(taskId: string): Promise<TaskContext> {
    const task = await this.getTask(taskId)
    const [documents, transitions] = await Promise.all([
      this.listDocuments(task.project_id),
      this.listTransitions(taskId),
    ])
    return { task, documents, transitions }
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private async transitionToInProgress(taskId: string, retries = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.request('PATCH', `/v1/agent-projects/tasks/${taskId}`, { status: 'in_progress' })
        return
      } catch (err) {
        if (i === retries - 1) throw err
        await new Promise(r => setTimeout(r, 500 * (i + 1)))
      }
    }
  }

  private async sendHeartbeat(taskId: string): Promise<{ lease_expires_at: string }> {
    return this.request<{ lease_expires_at: string }>(
      'POST',
      `/v1/agent-projects/tasks/${taskId}/heartbeat`,
      { agent_id: this.config.agentId },
    )
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.gatewayUrl}${path}`
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined

    const headers: Record<string, string> = {
      'Authorization': this.auth.getAuthHeader(),
      'x-api-key': this.config.apiKey,
    }

    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    if (this.config.signingKeyId && this.config.signingPrivateKey) {
      this.addSignatureHeaders(headers, method, path, bodyStr)
    }

    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr,
    })

    // 204 No Content
    if (res.status === 204) {
      return null as T
    }

    const json = await res.json().catch(() => null)

    if (!res.ok) {
      const message = (json as { error?: string })?.error
        ?? (json as { message?: string })?.message
        ?? res.statusText
      throw new AgentError(res.status, message, json)
    }

    // Unwrap { data: ... } envelope if present
    if (json && typeof json === 'object' && 'data' in json) {
      return (json as { data: T }).data
    }

    return json as T
  }

  private addSignatureHeaders(headers: Record<string, string>, method: string, path: string, body?: string): void {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID()
    const bodyHash = createHash('sha256').update(body ?? '').digest('hex')

    // Path without query params (gateway forwards path only)
    const pathOnly = path.split('?')[0]

    const signingString = `${method}\n${pathOnly}\n${timestamp}\n${nonce}\n${bodyHash}`
    const privateKey = createPrivateKey(this.config.signingPrivateKey!)
    const signature = sign(null, Buffer.from(signingString), privateKey).toString('base64')

    headers['X-Signature'] = signature
    headers['X-Signature-Timestamp'] = timestamp
    headers['X-Signature-Key-Id'] = this.config.signingKeyId!
    headers['X-Signature-Nonce'] = nonce
    headers['X-Body-Hash'] = bodyHash
  }
}
