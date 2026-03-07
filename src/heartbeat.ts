import { EventEmitter } from 'node:events'
import { AgentError } from './errors'

export type HeartbeatEvent = 'heartbeat:sent' | 'heartbeat:failed' | 'lease:expired' | 'task:cancelled'

export class HeartbeatManager extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null
  private currentTaskId: string | null = null
  private sendFn: ((taskId: string) => Promise<{ lease_expires_at: string }>) | null = null

  start(
    taskId: string,
    leaseExpiresAt: string,
    sendFn: (taskId: string) => Promise<{ lease_expires_at: string }>,
  ): void {
    this.stop()
    this.currentTaskId = taskId
    this.sendFn = sendFn

    const expiresMs = new Date(leaseExpiresAt).getTime()
    const intervalMs = Math.max(Math.floor((expiresMs - Date.now()) / 3), 5000)

    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.currentTaskId = null
    this.sendFn = null
  }

  get active(): boolean {
    return this.timer !== null
  }

  private async tick(): Promise<void> {
    if (!this.currentTaskId || !this.sendFn) return

    try {
      const result = await this.sendFn(this.currentTaskId)
      this.emit('heartbeat:sent', { taskId: this.currentTaskId, leaseExpiresAt: result.lease_expires_at })
    } catch (err) {
      if (err instanceof AgentError && err.status === 410) {
        this.emit('lease:expired', { taskId: this.currentTaskId })
        this.stop()
      } else if (err instanceof AgentError && err.status === 409) {
        this.emit('task:cancelled', { taskId: this.currentTaskId })
        this.stop()
      } else {
        this.emit('heartbeat:failed', { taskId: this.currentTaskId, error: err })
      }
    }
  }
}
