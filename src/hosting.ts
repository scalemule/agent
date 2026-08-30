export interface HostingRepository {
  clone_url_ssh: string
  default_branch: string
  dockerfile_path: string
  build_context: string
}

export interface HostingProject {
  id: string
  name: string
  slug: string
  description?: string | null
  plan_tier: string
  project_type: string
  status: string
  created_at: string
  repository?: HostingRepository | null
}

export interface Deployment {
  id: string
  project_id: string
  environment_id: string
  environment: string
  version?: string | null
  commit_sha?: string | null
  branch?: string | null
  image_tag?: string | null
  status: string
  url?: string | null
  started_at?: string | null
  completed_at?: string | null
  duration_ms?: number | null
  error_message?: string | null
  error_phase?: string | null
  triggered_by: string
  triggered_by_email?: string | null
  created_at: string
}

export interface ReleaseToken {
  id: string
  project_id: string
  environment?: string | null
  allowed_branch: string
  name: string
  token_prefix: string
  created_by_member_id: string
  expires_at?: string | null
  last_used_at?: string | null
  revoked_at?: string | null
  created_at: string
  token?: string
}

interface ApiEnvelope<T> {
  data: T
}

export class ScaleMuleHostingError extends Error {
  readonly status: number
  readonly code?: string
  readonly details: unknown

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message)
    this.name = 'ScaleMuleHostingError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface HostingClientOptions {
  apiUrl?: string
  deployToken?: string
  memberToken?: string
}

export interface TriggerReleaseOptions {
  environment: string
  commitSha: string
  branch: string
  idempotencyKey: string
}

export function isReleaseToken(value: string): boolean {
  return /^sm_rel_[0-9a-f]{32}_[0-9a-f]{64}$/i.test(value)
}

export function isUnsuccessfulDeploymentStatus(status: string): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'rolled_back'
}

function apiMessage(value: unknown, fallback: string): { message: string; code?: string } {
  if (!value || typeof value !== 'object') return { message: fallback }
  const body = value as Record<string, unknown>
  const error = body.error
  if (typeof error === 'string') return { message: error }
  if (error && typeof error === 'object') {
    const errorObject = error as Record<string, unknown>
    return {
      message: typeof errorObject.message === 'string' ? errorObject.message : fallback,
      code: typeof errorObject.code === 'string' ? errorObject.code : undefined,
    }
  }
  return {
    message: typeof body.message === 'string' ? body.message : fallback,
    code: typeof body.code === 'string' ? body.code : undefined,
  }
}

export class ScaleMuleHostingClient {
  private readonly apiUrl: string
  private readonly deployToken?: string
  private readonly memberToken?: string

  constructor(options: HostingClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? 'https://api.scalemule.com').replace(/\/+$/, '')
    this.deployToken = options.deployToken
    this.memberToken = options.memberToken
  }

  private async request<T>(
    method: string,
    path: string,
    auth: 'deploy' | 'member',
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers }
    if (auth === 'deploy') {
      if (!this.deployToken) throw new Error('HostingClientOptions.deployToken is required')
      requestHeaders['x-scalemule-deploy-token'] = this.deployToken
    } else {
      if (!this.memberToken) throw new Error('HostingClientOptions.memberToken is required')
      requestHeaders.Authorization = `Bearer ${this.memberToken}`
    }

    let encodedBody: string | undefined
    if (body !== undefined) {
      encodedBody = JSON.stringify(body)
      requestHeaders['Content-Type'] = 'application/json'
    }

    let response: Response
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: requestHeaders,
        body: encodedBody,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown network error'
      throw new ScaleMuleHostingError(0, `Unable to reach ScaleMule: ${reason}`)
    }

    if (response.ok && response.status === 204) return undefined as T

    const rawResponseBody = await response.text()
    let responseBody: ApiEnvelope<T> | T | null = null
    let responseWasJson = false
    if (rawResponseBody.trim()) {
      try {
        responseBody = JSON.parse(rawResponseBody) as ApiEnvelope<T> | T | null
        responseWasJson = true
      } catch {
        // Error responses retain their HTTP status below. Successful responses
        // fail closed because every non-204 hosting endpoint returns JSON.
      }
    }
    if (!response.ok) {
      const parsed = apiMessage(responseBody, `${response.status} ${response.statusText}`)
      throw new ScaleMuleHostingError(response.status, parsed.message, responseBody, parsed.code)
    }
    if (!responseWasJson || responseBody === null) {
      throw new ScaleMuleHostingError(
        response.status,
        'ScaleMule returned an empty or invalid JSON success response',
        undefined,
        'INVALID_RESPONSE',
      )
    }
    if (responseBody && typeof responseBody === 'object' && 'data' in responseBody) {
      return (responseBody as ApiEnvelope<T>).data
    }
    return responseBody as T
  }

  getReleaseProject(): Promise<HostingProject> {
    return this.request('GET', '/v1/hosting/release/project', 'deploy')
  }

  triggerRelease(options: TriggerReleaseOptions): Promise<Deployment> {
    return this.request('POST', '/v1/hosting/releases', 'deploy', {
      environment: options.environment,
      commit_sha: options.commitSha,
      branch: options.branch,
    }, { 'Idempotency-Key': options.idempotencyKey })
  }

  getRelease(deploymentId: string): Promise<Deployment> {
    return this.request('GET', `/v1/hosting/releases/${encodeURIComponent(deploymentId)}`, 'deploy')
  }

  listProjects(): Promise<HostingProject[]> {
    return this.request('GET', '/v1/hosting/projects', 'member')
  }

  createReleaseToken(
    project: string,
    options: { name: string; environment?: string; branch?: string; expiresInDays?: number },
  ): Promise<ReleaseToken> {
    return this.request(
      'POST',
      `/v1/hosting/projects/${encodeURIComponent(project)}/release-tokens`,
      'member',
      {
        name: options.name,
        environment: options.environment,
        branch: options.branch,
        expires_in_days: options.expiresInDays,
      },
    )
  }

  listReleaseTokens(project: string): Promise<ReleaseToken[]> {
    return this.request(
      'GET',
      `/v1/hosting/projects/${encodeURIComponent(project)}/release-tokens`,
      'member',
    )
  }

  revokeReleaseToken(project: string, tokenId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/v1/hosting/projects/${encodeURIComponent(project)}/release-tokens/${encodeURIComponent(tokenId)}`,
      'member',
    )
  }
}
