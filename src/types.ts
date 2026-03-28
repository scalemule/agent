export interface ScaleMuleAgentConfig {
  /** Application API key (sent as x-api-key header to gateway) */
  apiKey: string
  /** Agent bearer token with sma_ prefix (sent as Authorization: Bearer) */
  agentToken: string
  /** Agent registry ID (used in lifecycle request bodies) */
  agentId: string
  gatewayUrl?: string
  /** Refresh secret (smr_ prefix) — enables JWT exchange mode */
  refreshSecret?: string
  /** Signing key fingerprint from registration (required if app mandates request signing) */
  signingKeyId?: string
  /** Ed25519 private key PEM (required if app mandates request signing) */
  signingPrivateKey?: string
}

export type SignRequestFn = (
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: string,
) => void

export interface ClaimResult {
  task_id: string
  agent_id: string
  attempt_number: number
  lease_expires_at: string
  current_phase?: string
}

export interface SubmitResult {
  task_id: string
  idempotent?: boolean
}

export interface Task {
  id: string
  project_id: string
  title: string
  description?: string
  status: string
  priority?: string
  due_date?: string
  assigned_agent_id?: string
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
  pipeline_id?: string
  pipeline_version?: number
  current_phase?: string
  phase_entered_at?: string
}

export interface TaskTransition {
  id: string
  task_id: string
  from_state?: string
  to_state: string
  actor_id?: string
  actor_type: string
  reason?: string
  metadata?: Record<string, unknown>
  created_at: string
}

export interface ProjectDocument {
  id: string
  project_id: string
  title: string
  content?: string
  created_at: string
}

export interface TaskContext {
  task: Task
  documents: ProjectDocument[]
  transitions: TaskTransition[]
}

export interface SubmitOptions {
  output?: Record<string, unknown>
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  notes?: string
  idempotencyKey?: string
}

export interface BlockOptions {
  reason: string
  question?: string
}

export interface TokenExchangeResult {
  access_token: string
  expires_in: number
}
