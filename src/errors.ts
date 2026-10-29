export class TimeoutError extends Error {
  readonly code = 'CHAOS_TIMEOUT' as const
  readonly tool: string
  readonly delayMs: number

  constructor(tool: string, delayMs: number) {
    super(`Timeout calling "${tool}" after ${delayMs}ms`)
    this.name = 'TimeoutError'
    this.tool = tool
    this.delayMs = delayMs
  }
}

export class ChaosHttpError extends Error {
  readonly code = 'CHAOS_HTTP' as const
  readonly tool: string
  readonly status: number
  readonly retryAfter?: number

  constructor(tool: string, status: number, retryAfter?: number) {
    super(
      status === 429
        ? `Rate limited calling "${tool}" (429), retry after ${retryAfter}s`
        : `HTTP ${status} calling "${tool}"`,
    )
    this.name = 'ChaosHttpError'
    this.tool = tool
    this.status = status
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}

export function isChaosError(error: unknown): error is TimeoutError | ChaosHttpError {
  return error instanceof TimeoutError || error instanceof ChaosHttpError
}
