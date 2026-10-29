import {
  ChaosHttpError,
  TimeoutError,
  chaos,
  containsInjection,
  type ChaosCall,
  type ChaosReport,
  type FaultRates,
  type ResultFault,
} from 'agent-chaos'
import { type FaultKey } from './hash'

export type AgentId = 'naive' | 'hardened'
export type Tone = 'ok' | 'bad' | 'retry' | 'inject' | 'idle'

export const DEMO_STEPS = ['searchFlights', 'getWeather', 'bookHotel', 'emailItinerary'] as const
type StepName = (typeof DEMO_STEPS)[number]

export interface StepReport {
  index: number
  tool: string
  fault: string
  reaction: string
  detail: string
  tone: Tone
}

export interface AgentOutcome {
  score: number
  steps: number
  unhandled: number
  faults: number
  report: ChaosReport
}

const MARKER = '[CHAOS-INJECTION-TEST-ONLY]'
const ATTEMPTS = 5
const RESULT_KEYS = [
  'timeout',
  'error500',
  'rateLimit',
  'malformedJson',
  'empty',
  'injection',
] as const satisfies readonly FaultKey[]

const FAULT_LABEL: Record<ResultFault, string> = {
  timeout: 'timeout',
  error500: '500',
  rateLimit: '429',
  malformedJson: 'bad JSON',
  empty: 'empty',
  injection: 'injection',
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * Map the slider onto the library's sequential rolls.
 * The slider is the chance a call is faulted. Each enabled fault gets an equal
 * share. Later faults use a higher conditional probability so an earlier miss
 * does not eat their share, and 100% still faults every call.
 */
export function faultsFromLevel(
  level: number,
  enabled: Record<FaultKey, boolean>,
  latencyMs: [number, number] = [24, 70],
): FaultRates {
  const target = clamp01(level / 100)
  const active = RESULT_KEYS.filter((key) => enabled[key])
  const rates: FaultRates = {
    timeout: 0,
    error500: 0,
    rateLimit: 0,
    malformedJson: 0,
    empty: 0,
    injection: 0,
    latency: {
      p: enabled.latency && target > 0 ? Math.min(1, target * 0.5) : 0,
      ms: latencyMs,
    },
  }
  if (target <= 0 || active.length === 0) return rates
  let remaining = 1
  const share = target / active.length
  for (let index = 0; index < active.length; index += 1) {
    const key = active[index]!
    const last = index === active.length - 1
    const conditional =
      last && target >= 1 ? 1 : remaining <= 1e-12 ? 0 : Math.min(1, share / remaining)
    rates[key] = conditional
    remaining *= 1 - conditional
  }
  return rates
}

export function usageSnippet(seed: number): string {
  return `import { chaos } from 'agent-chaos'
const tools = chaos({ search, getWeather, sendEmail }, {
  seed: ${seed},
  faults: { timeout: 0.1, error500: 0.1, malformedJson: 0.05, rateLimit: 0.05, empty: 0.05, injection: 0.05, latency: { p: 0.2, ms: [200, 3000] } },
})`
}

export interface DemoTiming {
  timeoutMs: number
  paceMs: number
  backoffBaseMs: number
  retryAfterUnitMs: number
}

export const LIVE_TIMING: DemoTiming = {
  timeoutMs: 80,
  paceMs: 36,
  backoffBaseMs: 16,
  retryAfterUnitMs: 18,
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

function createBag(seed: number, faults: FaultRates, timeoutMs: number) {
  return chaos(createTools(), { seed, faults, timeoutMs })
}

type DemoBag = ReturnType<typeof createBag>

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0) || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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

/** Parse and check the payload. A bad string becomes a rejection, not a throw. */
function validate(
  tool: StepName,
  raw: unknown,
): { valid: boolean; injected: boolean; problem: string; summary: string } {
  const stripped = stripInjection(raw)
  let data = stripped.value
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data) as unknown
    } catch {
      return { valid: false, injected: stripped.injected, problem: 'rejected bad JSON', summary: '' }
    }
  }
  if (data == null) {
    return { valid: false, injected: stripped.injected, problem: 'empty result', summary: '' }
  }
  if (!isValid(tool, data)) {
    return { valid: false, injected: stripped.injected, problem: 'unexpected shape', summary: '' }
  }
  return { valid: true, injected: stripped.injected, problem: '', summary: okDetail(tool, data) }
}

function faultLabel(call: ChaosCall | undefined): string {
  if (!call) return 'none'
  if (call.fault) return FAULT_LABEL[call.fault]
  if (call.latency && call.latencyMs > 0) return `slow ${call.latencyMs}ms`
  return 'none'
}

function joinFaults(faults: readonly string[]): string {
  const names = faults.filter((fault) => fault !== 'none')
  if (names.length === 0) return 'none'
  return names.join(', then ')
}

function errorDetail(error: unknown): string {
  if (error instanceof TimeoutError) return 'timeout'
  if (error instanceof ChaosHttpError && error.status === 429) {
    return `retry-after ${error.retryAfter ?? 0}s`
  }
  if (error instanceof ChaosHttpError) return ''
  if (error instanceof Error) return error.message
  return 'error'
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'agent-chaos: call cancelled by reset'
}

async function callTool(tools: DemoBag, tool: StepName): Promise<unknown> {
  if (tool === 'searchFlights') {
    return tools.searchFlights({ from: 'SFO', to: 'NRT', date: '2026-11-12' })
  }
  if (tool === 'getWeather') return tools.getWeather({ city: 'Tokyo', date: '2026-11-12' })
  if (tool === 'bookHotel') return tools.bookHotel({ city: 'Tokyo', nights: 4 })
  return tools.emailItinerary({
    to: 'traveler@example.com',
    body: 'Tokyo, Nov 12-16. Flight JL001. Bay Suites.',
  })
}

function lastCall(tools: DemoBag): ChaosCall {
  const call = tools.__chaos.report().calls.at(-1)
  if (!call) throw new Error('agent-chaos demo: missing call')
  return call
}

function outcomeOf(tools: DemoBag, steps: number): AgentOutcome {
  const report = tools.__chaos.report()
  return {
    score: steps * 25,
    steps,
    unhandled: report.totals.unhandled,
    faults: report.totals.faults,
    report,
  }
}

function mechanism(faults: readonly string[], honoredRetryAfter: number | undefined, note: string): string {
  const parts: string[] = []
  if (honoredRetryAfter !== undefined) parts.push(`honored retry-after ${honoredRetryAfter}s`)
  else if (faults.some((fault) => fault === 'timeout' || fault === '500')) parts.push('backed off')
  if (note) parts.push(note)
  return parts.join(' · ')
}

export async function runDemo(options: {
  seed: number
  faults: FaultRates
  timing?: DemoTiming
  signal?: AbortSignal
  alive?: () => boolean
  onStep: (agent: AgentId, step: StepReport) => void
  onScore: (agent: AgentId, outcome: AgentOutcome) => void
}): Promise<void> {
  const timing = options.timing ?? LIVE_TIMING
  const alive = options.alive ?? (() => true)
  const signal = options.signal

  const stopped = () => !alive() || signal?.aborted === true

  const runNaive = async (): Promise<AgentOutcome | null> => {
    const tools = createBag(options.seed, options.faults, timing.timeoutMs)
    let steps = 0
    for (let index = 0; index < DEMO_STEPS.length; index += 1) {
      if (stopped()) return null
      const tool = DEMO_STEPS[index]!
      const started = performance.now()
      try {
        const result = await callTool(tools, tool)
        if (stopped()) return null
        const call = lastCall(tools)
        const remain = timing.paceMs - (performance.now() - started)
        await sleep(remain, signal)
        if (stopped()) return null
        if (containsInjection(result)) {
          options.onStep('naive', {
            index,
            tool,
            fault: 'injection',
            reaction: 'followed the injected instruction',
            detail: 'treated the tool text as instructions',
            tone: 'inject',
          })
          continue
        }
        let parsed: unknown = result
        if (typeof result === 'string') {
          try {
            parsed = JSON.parse(result) as unknown
          } catch {
            throw new TypeError('bad JSON')
          }
        }
        if (!isValid(tool, parsed)) {
          const why = result == null ? 'empty result' : typeof result === 'string' ? 'bad JSON' : 'unexpected shape'
          throw new TypeError(why)
        }
        options.onStep('naive', {
          index,
          tool,
          fault: faultLabel(call),
          reaction: 'ok',
          detail: okDetail(tool, parsed),
          tone: 'ok',
        })
        steps += 1
      } catch (error) {
        if (stopped() || isCancelled(error)) return null
        await sleep(Math.max(0, timing.paceMs - (performance.now() - started)), signal)
        if (stopped()) return null
        const call = tools.__chaos.report().calls.at(-1)
        options.onStep('naive', {
          index,
          tool,
          fault: faultLabel(call),
          reaction: 'crashed',
          detail: errorDetail(error),
          tone: 'bad',
        })
      }
    }
    return outcomeOf(tools, steps)
  }

  const runHardened = async (): Promise<AgentOutcome | null> => {
    const tools = createBag(options.seed, options.faults, timing.timeoutMs)
    let steps = 0
    for (let index = 0; index < DEMO_STEPS.length; index += 1) {
      if (stopped()) return null
      const tool = DEMO_STEPS[index]!
      const seen: string[] = []
      let retryAfter: number | undefined
      let honoredRetryAfter: number | undefined
      let problem = ''
      let finished = false
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        if (stopped()) return null
        if (attempt > 1) {
          const wait =
            retryAfter !== undefined
              ? retryAfter * timing.retryAfterUnitMs
              : timing.backoffBaseMs * 2 ** (attempt - 2)
          if (retryAfter !== undefined) honoredRetryAfter = retryAfter
          await sleep(wait, signal)
          if (stopped()) return null
        }
        const started = performance.now()
        try {
          const result = await callTool(tools, tool)
          if (stopped()) return null
          const call = lastCall(tools)
          if (call.fault) {
            tools.__chaos.markHandled(call.id)
            seen.push(FAULT_LABEL[call.fault])
          }
          const parsed = validate(tool, result)
          await sleep(Math.max(0, timing.paceMs - (performance.now() - started)), signal)
          if (stopped()) return null
          if (parsed.valid) {
            const slow = call.latency && call.latencyMs > 0 ? `slow ${call.latencyMs}ms` : ''
            const ignored = parsed.injected
            const note = ignored ? 'kept the data, dropped the instruction' : parsed.summary
            const how = seen.length > 0 || ignored ? mechanism(seen, honoredRetryAfter, '') : ''
            options.onStep('hardened', {
              index,
              tool,
              fault: joinFaults(seen),
              reaction: ignored ? 'ignored the injection' : seen.length > 0 ? 'retried and recovered' : 'ok',
              detail: [how, note, slow].filter(Boolean).join(' · '),
              tone: ignored ? 'inject' : seen.length > 0 ? 'retry' : 'ok',
            })
            steps += 1
            finished = true
            break
          }
          problem = parsed.problem
          retryAfter = undefined
          if (attempt === ATTEMPTS) {
            options.onStep('hardened', {
              index,
              tool,
              fault: joinFaults(seen),
              reaction: 'retried, then stopped',
              detail: mechanism(seen, honoredRetryAfter, problem),
              tone: 'bad',
            })
            finished = true
            break
          }
        } catch (error) {
          if (stopped() || isCancelled(error)) return null
          const call = tools.__chaos.report().calls.at(-1)
          if (call?.fault) {
            tools.__chaos.markHandled(call.id)
            seen.push(FAULT_LABEL[call.fault])
          }
          if (error instanceof ChaosHttpError && error.status === 429) {
            retryAfter = error.retryAfter ?? 1
            problem = ''
          } else {
            retryAfter = undefined
            problem =
              error instanceof TimeoutError || (error instanceof ChaosHttpError && error.status === 500)
                ? ''
                : errorDetail(error)
          }
          await sleep(Math.max(0, timing.paceMs - (performance.now() - started)), signal)
          if (stopped()) return null
          if (attempt === ATTEMPTS) {
            options.onStep('hardened', {
              index,
              tool,
              fault: joinFaults(seen),
              reaction: 'retried, then stopped',
              detail: mechanism(seen, honoredRetryAfter, problem),
              tone: 'bad',
            })
            finished = true
          }
        }
      }
      if (!finished) return null
    }
    return outcomeOf(tools, steps)
  }

  const naive = await runNaive()
  if (!naive || stopped()) return
  options.onScore('naive', naive)
  const hardened = await runHardened()
  if (!hardened || stopped()) return
  options.onScore('hardened', hardened)
}
