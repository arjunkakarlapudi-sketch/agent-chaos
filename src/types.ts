/** Result-replacing faults. Latency is rolled separately and can stack. */
export type ResultFault =
  | 'timeout'
  | 'error500'
  | 'rateLimit'
  | 'malformedJson'
  | 'empty'
  | 'injection'

export type FaultType = ResultFault | 'latency'

export interface LatencyFault {
  /** Probability from 0 to 1. */
  p: number
  /** Inclusive delay range in milliseconds. */
  ms: [number, number]
}

export interface FaultRates {
  timeout?: number
  error500?: number
  rateLimit?: number
  malformedJson?: number
  empty?: number
  injection?: number
  latency?: LatencyFault
}

export interface FaultEvent {
  callId: number
  tool: string
  type: FaultType
  latencyMs?: number
  status?: number
  retryAfter?: number
}

export interface ChaosOptions {
  /**
   * Seed for the mulberry32 PRNG. The same seed and the same call order
   * replay the same faults. Omitted seeds use 1, so a run is reproducible
   * unless you pass a random seed yourself.
   */
  seed?: number
  faults?: FaultRates
  onFault?: (event: FaultEvent) => void
  /** How long a timeout fault waits before throwing. Default 1000. */
  timeoutMs?: number
}

export type ToolFn = (...args: any[]) => unknown

export type Promisify<F extends ToolFn> = (
  ...args: Parameters<F>
) => Promise<Awaited<ReturnType<F>>>

export interface ChaosErrorInfo {
  name: string
  message: string
  status?: number
  retryAfter?: number
}

export type CallOutcome = 'ok' | 'thrown' | 'returned'

export interface ChaosCall {
  id: number
  tool: string
  args: unknown[]
  /** Result-replacing fault, if one fired. */
  fault: ResultFault | null
  /** True when the latency roll hit, even if the sampled delay is 0. */
  latency: boolean
  latencyMs: number
  outcome: CallOutcome
  /** False when a result fault reached the caller and nobody marked it handled. */
  handled: boolean
  durationMs: number
  injection: boolean
  error?: ChaosErrorInfo
}

export interface ToolTotals {
  calls: number
  faults: number
}

export interface ChaosTotals {
  calls: number
  /** Calls where a result fault or a latency fault fired. */
  faults: number
  /** Result faults that were not marked handled. Latency-only calls are handled. */
  unhandled: number
  ok: number
  byType: Record<FaultType, number>
  byTool: Record<string, ToolTotals>
}

export interface ChaosReport {
  seed: number
  calls: ChaosCall[]
  totals: ChaosTotals
}

export interface ChaosHandle {
  readonly seed: number
  report: () => ChaosReport
  /** Clears the report and rewinds the PRNG so the next calls replay this seed. */
  reset: () => void
  /**
   * Mark a result fault as handled after the agent retries or rejects bad data.
   * Defaults to the most recent call.
   */
  markHandled: (callId?: number) => void
}

export type ChaosBag<T extends Record<string, ToolFn>> = {
  [K in keyof T]: Promisify<T[K]>
} & {
  readonly __chaos: ChaosHandle
}
