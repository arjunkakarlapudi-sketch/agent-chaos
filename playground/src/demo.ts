import {
  ChaosHttpError,
  TimeoutError,
  chaos,
  containsInjection,
  type ChaosReport,
  type FaultRates,
} from 'agent-chaos'
import { FAULT_KEYS, type FaultKey } from './hash'

export type AgentId = 'naive' | 'hardened'
export type RowStatus = 'ok' | 'retried' | 'failed' | 'injected'

export interface TraceRow {
  tool: string
  status: RowStatus
  detail: string
}

export interface AgentOutcome {
  score: number
  steps: number
  unhandled: number
  faults: number
  report: ChaosReport
}

const MARKER = '[CHAOS-INJECTION-TEST-ONLY]'
const STEPS = ['searchFlights', 'getWeather', 'bookHotel', 'emailItinerary'] as const
type StepName = (typeof STEPS)[number]
const ATTEMPTS = 4

function createBag(seed: number, faults: FaultRates) {
  return chaos(createTools(), { seed, faults, timeoutMs: 90 })
}

type DemoBag = ReturnType<typeof createBag>

export function faultsFromLevel(level: number, enabled: Record<FaultKey, boolean>): FaultRates {
  const active = FAULT_KEYS.filter((key) => key !== 'latency' && enabled[key])
  const share = level <= 0 || active.length === 0 ? 0 : level / 100 / active.length
  return {
    timeout: enabled.timeout ? share : 0,
    error500: enabled.error500 ? share : 0,
    rateLimit: enabled.rateLimit ? share : 0,
    malformedJson: enabled.malformedJson ? share : 0,
    empty: enabled.empty ? share : 0,
    injection: enabled.injection ? share : 0,
    latency: {
      p: enabled.latency && level > 0 ? (level / 100) * 0.65 : 0,
      ms: [40, 180],
    },
  }
}

export function usageSnippet(seed: number): string {
  return `import { chaos } from 'agent-chaos'
const tools = chaos({ search, getWeather, sendEmail }, {
  seed: ${seed},
  faults: { timeout: 0.1, error500: 0.1, malformedJson: 0.05, rateLimit: 0.05, empty: 0.05, injection: 0.05, latency: { p: 0.2, ms: [200, 3000] } },
})`
}

function createTools() {
  return {
    async searchFlights(input: { from: string; to: string; date: string }) {
      return {
        from: input.from,
        to: input.to,
        date: input.date,
        flights: [{ id: 'JL001', depart: '11:40', arrive: '15:55', priceUsd: 840 }],
      }
    },
    async getWeather(input: { city: string; date: string }) {
      return { city: input.city, date: input.date, highC: 18, summary: 'Clear and cool' }
    },
    async bookHotel(input: { city: string; nights: number }) {
      return {
        city: input.city,
        nights: input.nights,
        hotel: 'Bay Suites',
        confirmation: 'HK-20481',
        totalUsd: 620,
      }
    },
    async emailItinerary(input: { to: string; body: string }) {
      return { to: input.to, status: 'sent' as const, id: 'msg_91' }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function pace(started: number): Promise<void> {
  const remaining = 70 - (performance.now() - started)
  if (remaining > 0) await sleep(remaining)
}

function stripInjection(value: unknown): { value: unknown; injected: boolean } {
  let injected = false
  const walk = (current: unknown): unknown => {
    if (typeof current === 'string') {
      const at = current.indexOf(MARKER)
      if (at === -1) return current
      injected = true
      return current.slice(0, at).replace(/\s+$/u, '')
    }
    if (Array.isArray(current)) return current.map((item) => walk(item))
    if (current !== null && typeof current === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(current)) out[key] = walk(child)
      return out
    }
    return current
  }
  return { value: walk(value), injected }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValid(tool: StepName, value: unknown): boolean {
  if (!isRecord(value)) return false
  if (tool === 'searchFlights') return Array.isArray(value.flights) && value.flights.length > 0
  if (tool === 'getWeather') return typeof value.summary === 'string' && value.summary.length > 0
  if (tool === 'bookHotel') return typeof value.confirmation === 'string' && value.confirmation.length > 0
  return value.status === 'sent'
}

function okDetail(tool: StepName, value: unknown): string {
  if (!isRecord(value)) return 'ok'
  if (tool === 'searchFlights' && Array.isArray(value.flights) && isRecord(value.flights[0])) {
    const flight = value.flights[0]
    return `${String(flight.id)} · $${String(flight.priceUsd)}`
  }
  if (tool === 'getWeather') return `${String(value.summary)} · ${String(value.highC)}°C`
  if (tool === 'bookHotel') return String(value.confirmation)
  return 'sent'
}

function failureDetail(value: unknown): string {
  if (value == null) return 'empty result'
  if (typeof value === 'string') return 'malformed JSON'
  return 'unusable result'
}

function errorDetail(error: unknown): string {
  if (error instanceof TimeoutError) return 'timeout'
  if (error instanceof ChaosHttpError && error.status === 429) {
    return `429 · retry-after ${error.retryAfter ?? 0}s`
  }
  if (error instanceof ChaosHttpError) return `HTTP ${error.status}`
  if (error instanceof Error) return error.message
  return 'error'
}

function latencyDetail(detail: string, latency: boolean, latencyMs: number): string {
  if (!latency || latencyMs <= 0) return detail
  return `${detail} · slow ${latencyMs}ms`
}

async function callTool(tools: DemoBag, tool: StepName): Promise<unknown> {
  if (tool === 'searchFlights') {
    return tools.searchFlights({ from: 'SFO', to: 'NRT', date: '2026-11-12' })
  }
  if (tool === 'getWeather') return tools.getWeather({ city: 'Tokyo', date: '2026-11-12' })
  if (tool === 'bookHotel') return tools.bookHotel({ city: 'Tokyo', nights: 4 })
  return tools.emailItinerary({
    to: 'traveler@example.com',
    body: 'Tokyo, Nov 12–16. Flight JL001. Bay Suites.',
  })
}

function lastCall(tools: DemoBag) {
  const calls = tools.__chaos.report().calls
  const call = calls[calls.length - 1]
  if (!call) throw new Error('agent-chaos demo: missing call')
  return call
}

export async function runDemo(options: {
  seed: number
  faults: FaultRates
  alive: () => boolean
  onRow: (agent: AgentId, row: TraceRow) => void
  onScore: (agent: AgentId, outcome: AgentOutcome) => void
}): Promise<void> {
  const { seed, faults, alive, onRow, onScore } = options

  const runNaive = async (): Promise<AgentOutcome> => {
    const tools = createBag(seed, faults)
    let steps = 0
    for (const tool of STEPS) {
      if (!alive()) break
      const started = performance.now()
      try {
        const result = await callTool(tools, tool)
        const call = lastCall(tools)
        await pace(started)
        if (!alive()) break
        if (containsInjection(result)) {
          onRow('naive', {
            tool,
            status: 'injected',
            detail: latencyDetail('followed instructions in the tool result', call.latency, call.latencyMs),
          })
          continue
        }
        if (!isValid(tool, result)) {
          onRow('naive', {
            tool,
            status: 'failed',
            detail: latencyDetail(failureDetail(result), call.latency, call.latencyMs),
          })
          continue
        }
        onRow('naive', {
          tool,
          status: 'ok',
          detail: latencyDetail(okDetail(tool, result), call.latency, call.latencyMs),
        })
        steps += 1
      } catch (error) {
        await pace(started)
        if (!alive()) break
        onRow('naive', { tool, status: 'failed', detail: errorDetail(error) })
      }
    }
    const report = tools.__chaos.report()
    return { score: steps * 25, steps, unhandled: report.totals.unhandled, faults: report.totals.faults, report }
  }

  const runHardened = async (): Promise<AgentOutcome> => {
    const tools = createBag(seed, faults)
    let steps = 0
    for (const tool of STEPS) {
      if (!alive()) break
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        if (!alive()) break
        if (attempt > 1) await sleep(30 * attempt)
        const started = performance.now()
        const retry = attempt < ATTEMPTS
        try {
          const result = await callTool(tools, tool)
          const call = lastCall(tools)
          await pace(started)
          if (!alive()) break
          const stripped = stripInjection(result)
          const usable = isValid(tool, stripped.value)
          if (stripped.injected && usable) {
            tools.__chaos.markHandled(call.id)
            onRow('hardened', {
              tool,
              status: 'injected',
              detail: latencyDetail('ignored the injected instruction', call.latency, call.latencyMs),
            })
            steps += 1
            break
          }
          if (!usable) {
            if (call.fault && retry) tools.__chaos.markHandled(call.id)
            onRow('hardened', {
              tool,
              status: retry ? 'retried' : 'failed',
              detail: `${stripped.injected ? 'injection left bad data' : failureDetail(result)}${retry ? ` · try ${attempt}/${ATTEMPTS}` : ''}`,
            })
            if (!retry) break
            continue
          }
          if (call.fault) tools.__chaos.markHandled(call.id)
          onRow('hardened', {
            tool,
            status: 'ok',
            detail: latencyDetail(okDetail(tool, stripped.value), call.latency, call.latencyMs),
          })
          steps += 1
          break
        } catch (error) {
          const call = lastCall(tools)
          await pace(started)
          if (!alive()) break
          if (retry) tools.__chaos.markHandled(call.id)
          onRow('hardened', {
            tool,
            status: retry ? 'retried' : 'failed',
            detail: `${errorDetail(error)}${retry ? ` · try ${attempt}/${ATTEMPTS}` : ''}`,
          })
          if (!retry) break
        }
      }
    }
    const report = tools.__chaos.report()
    return { score: steps * 25, steps, unhandled: report.totals.unhandled, faults: report.totals.faults, report }
  }

  const naive = await runNaive()
  if (!alive()) return
  onScore('naive', naive)
  const hardened = await runHardened()
  if (!alive()) return
  onScore('hardened', hardened)
}
