import type { ChaosReport } from './types.js'

export class ResilienceError extends Error {
  readonly unhandled: number
  readonly maxUnhandled: number

  constructor(message: string, unhandled: number, maxUnhandled: number) {
    super(message)
    this.name = 'ResilienceError'
    this.unhandled = unhandled
    this.maxUnhandled = maxUnhandled
  }
}

/**
 * Fail a test when too many result faults reached the caller unmarked.
 * Call `markHandled` after a retry or a validation check succeeds.
 */
export function assertResilient(
  report: ChaosReport,
  options: { maxUnhandled?: number } = {},
): void {
  if (report == null || !Array.isArray(report.calls)) {
    throw new TypeError('agent-chaos: assertResilient expected a chaos report')
  }
  const maxUnhandled =
    typeof options.maxUnhandled === 'number' && Number.isFinite(options.maxUnhandled)
      ? Math.max(0, options.maxUnhandled)
      : 0
  const bad = report.calls.filter((call) => call.fault !== null && !call.handled)
  if (bad.length > maxUnhandled) {
    const detail = bad
      .map((call) => {
        const extra = call.error ? ` (${call.error.name}: ${call.error.message})` : ''
        return `#${call.id} ${call.tool} ${call.fault}${extra}`
      })
      .join('; ')
    const noun = bad.length === 1 ? 'fault' : 'faults'
    throw new ResilienceError(
      `agent-chaos: ${bad.length} unhandled ${noun}, maximum is ${maxUnhandled}: ${detail}. Call markHandled(callId) after the agent retries or rejects the bad result.`,
      bad.length,
      maxUnhandled,
    )
  }
}
