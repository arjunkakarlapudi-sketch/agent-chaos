import { ChaosHttpError, TimeoutError, isChaosError } from './errors.js'
import { applyInjection } from './inject.js'
import { createRng, normalizeSeed } from './prng.js'
import { sleep } from './sleep.js'
import type {
  ChaosBag,
  ChaosCall,
  ChaosErrorInfo,
  ChaosHandle,
  ChaosOptions,
  ChaosTotals,
  FaultEvent,
  FaultRates,
  FaultType,
  Promisify,
  ResultFault,
  ToolFn,
} from './types.js'

const RESULT_ORDER: readonly ResultFault[] = [
  'timeout',
  'error500',
  'rateLimit',
  'malformedJson',
  'empty',
  'injection',
]

const EMPTY_BY_TYPE = (): Record<FaultType, number> => ({
  timeout: 0,
  error500: 0,
  rateLimit: 0,
  malformedJson: 0,
  empty: 0,
  injection: 0,
  latency: 0,
})

function clamp01(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function cleanTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 1000
  return Math.round(value)
}

function copyFaults(faults: FaultRates | undefined): FaultRates {
  if (!faults) return {}
  const copy: FaultRates = { ...faults }
  if (faults.latency) {
    const ms = faults.latency.ms
    copy.latency = {
      p: faults.latency.p,
      ms: [ms?.[0] ?? 200, ms?.[1] ?? 3000],
    }
  }
  return copy
}

function latencyDelay(rng: () => number, faults: FaultRates): { hit: boolean; ms: number } {
  const latency = faults.latency
  const p = clamp01(latency?.p)
  if (!latency || p <= 0) return { hit: false, ms: 0 }
  if (rng() >= p) return { hit: false, ms: 0 }
  let min = latency.ms?.[0] ?? 200
  let max = latency.ms?.[1] ?? 3000
  if (!Number.isFinite(min)) min = 0
  if (!Number.isFinite(max)) max = min
  if (min > max) [min, max] = [max, min]
  min = Math.max(0, Math.round(min))
  max = Math.max(0, Math.round(max))
  const ms = min + Math.floor(rng() * (max - min + 1))
  return { hit: true, ms }
}

function rollResultFault(rng: () => number, faults: FaultRates): ResultFault | null {
  for (const type of RESULT_ORDER) {
    const p = clamp01(faults[type])
    if (p <= 0) continue
    if (rng() < p) return type
  }
  return null
}

function corruptJson(tool: string, rng: () => number): string {
  const full = JSON.stringify({ tool, ok: true, items: [{ id: 'a1', value: 3 }] })
  const keep = Math.max(4, Math.floor(full.length * (0.35 + rng() * 0.4)))
  return `${full.slice(0, keep)}{"`
}

function safeArgs(args: unknown[]): unknown[] {
  try {
    const json = JSON.stringify(args, (_key, value) => {
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'function') return '[function]'
      if (typeof value === 'undefined') return null
      return value
    })
    const parsed = json === undefined ? [] : (JSON.parse(json) as unknown)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return args.map((value) => {
      try {
        return JSON.parse(JSON.stringify(value)) as unknown
      } catch {
        return String(value)
      }
    })
  }
}

function errorInfo(error: unknown): ChaosErrorInfo {
  if (error instanceof TimeoutError) {
    return { name: error.name, message: error.message }
  }
  if (error instanceof ChaosHttpError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    }
  }
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}

function emit(onFault: ChaosOptions['onFault'], event: FaultEvent): void {
  if (!onFault) return
  try {
    onFault(event)
  } catch {
    // A logging callback must not swallow the fault.
  }
}

function totalsFor(calls: readonly ChaosCall[]): ChaosTotals {
  const byType = EMPTY_BY_TYPE()
  const byTool: ChaosTotals['byTool'] = {}
  let faults = 0
  let unhandled = 0
  let ok = 0
  for (const call of calls) {
    const tool = (byTool[call.tool] ??= { calls: 0, faults: 0 })
    tool.calls += 1
    if (call.fault) byType[call.fault] += 1
    if (call.latency) byType.latency += 1
    const faulted = call.fault !== null || call.latency
    if (faulted) {
      faults += 1
      tool.faults += 1
    }
    if (call.fault !== null && !call.handled) unhandled += 1
    if (call.outcome === 'ok') ok += 1
  }
  return { calls: calls.length, faults, unhandled, ok, byType, byTool }
}

function snapshotCall(call: ChaosCall): ChaosCall {
  return {
    ...call,
    args: [...call.args],
    ...(call.error ? { error: { ...call.error } } : {}),
  }
}

/**
 * Wrap every function in `tools` with a seeded fault injector.
 * One bag shares one PRNG, so call order is part of the replay.
 */
export function chaos<T extends Record<string, ToolFn>>(
  tools: T,
  options: ChaosOptions = {},
): ChaosBag<T> {
  if (tools == null || typeof tools !== 'object') {
    throw new TypeError('agent-chaos: expected an object of tool functions')
  }

  const seed = normalizeSeed(options.seed)
  const faults = copyFaults(options.faults)
  const timeoutMs = cleanTimeoutMs(options.timeoutMs)
  const onFault = options.onFault
  let rng = createRng(seed)
  let seq = 0
  const calls: ChaosCall[] = []

  const handle: ChaosHandle = {
    seed,
    report() {
      return { seed, calls: calls.map(snapshotCall), totals: totalsFor(calls) }
    },
    reset() {
      calls.length = 0
      seq = 0
      rng = createRng(seed)
    },
    markHandled(callId?: number) {
      const id = callId ?? calls[calls.length - 1]?.id
      const call = calls.find((item) => item.id === id)
      if (!call) {
        throw new Error(
          id === undefined
            ? 'agent-chaos: no call to mark handled'
            : `agent-chaos: no call ${id}`,
        )
      }
      call.handled = true
    },
  }

  async function run(name: string, fn: ToolFn, args: unknown[]): Promise<unknown> {
    const id = ++seq
    const started = performance.now()
    const record: ChaosCall = {
      id,
      tool: name,
      args: safeArgs(args),
      fault: null,
      latency: false,
      latencyMs: 0,
      outcome: 'ok',
      handled: true,
      durationMs: 0,
      injection: false,
    }
    calls.push(record)

    const elapsed = () => Math.max(0, Math.round(performance.now() - started))

    try {
      const latency = latencyDelay(rng, faults)
      if (latency.hit) {
        record.latency = true
        record.latencyMs = latency.ms
        emit(onFault, { callId: id, tool: name, type: 'latency', latencyMs: latency.ms })
        if (latency.ms > 0) await sleep(latency.ms)
      }

      const fault = rollResultFault(rng, faults)
      if (fault === 'timeout') {
        emit(onFault, { callId: id, tool: name, type: 'timeout' })
        if (timeoutMs > 0) await sleep(timeoutMs)
        const error = new TimeoutError(name, timeoutMs)
        record.fault = fault
        record.outcome = 'thrown'
        record.handled = false
        record.error = errorInfo(error)
        record.durationMs = elapsed()
        throw error
      }

      if (fault === 'error500' || fault === 'rateLimit') {
        const status = fault === 'rateLimit' ? 429 : 500
        const retryAfter = fault === 'rateLimit' ? 1 + Math.floor(rng() * 3) : undefined
        const error = new ChaosHttpError(name, status, retryAfter)
        emit(onFault, {
          callId: id,
          tool: name,
          type: fault,
          status,
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        })
        record.fault = fault
        record.outcome = 'thrown'
        record.handled = false
        record.error = errorInfo(error)
        record.durationMs = elapsed()
        throw error
      }

      if (fault === 'malformedJson') {
        emit(onFault, { callId: id, tool: name, type: fault })
        record.fault = fault
        record.outcome = 'returned'
        record.handled = false
        record.durationMs = elapsed()
        return corruptJson(name, rng)
      }

      if (fault === 'empty') {
        emit(onFault, { callId: id, tool: name, type: fault })
        record.fault = fault
        record.outcome = 'returned'
        record.handled = false
        record.durationMs = elapsed()
        return null
      }

      const value = await Promise.resolve(fn(...args))

      if (fault === 'injection') {
        emit(onFault, { callId: id, tool: name, type: 'injection' })
        record.fault = 'injection'
        record.outcome = 'returned'
        record.handled = false
        record.injection = true
        record.durationMs = elapsed()
        return applyInjection(value)
      }

      record.outcome = 'ok'
      record.handled = true
      record.durationMs = elapsed()
      return value
    } catch (error) {
      if (isChaosError(error) && record.outcome === 'thrown') throw error
      record.outcome = 'thrown'
      record.handled = false
      record.error = errorInfo(error)
      record.durationMs = elapsed()
      throw error
    }
  }

  const bag = {} as ChaosBag<T>
  for (const key of Object.keys(tools)) {
    if (key === '__chaos') {
      throw new TypeError('agent-chaos: "__chaos" is reserved')
    }
    const fn = tools[key]
    if (typeof fn !== 'function') {
      throw new TypeError(`agent-chaos: tool "${key}" is not a function`)
    }
    const wrapped = (async (...args: unknown[]) => run(key, fn as ToolFn, args)) as Promisify<ToolFn>
    Object.defineProperty(wrapped, 'name', { value: fn.name || key, configurable: true })
    Object.defineProperty(bag, key, { value: wrapped, enumerable: true, writable: false })
  }
  Object.defineProperty(bag, '__chaos', { value: handle, enumerable: false })
  return bag
}
