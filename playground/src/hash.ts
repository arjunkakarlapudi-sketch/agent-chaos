export const FAULT_KEYS = [
  'timeout',
  'error500',
  'rateLimit',
  'malformedJson',
  'empty',
  'injection',
  'latency',
] as const

export type FaultKey = (typeof FAULT_KEYS)[number]

export interface Controls {
  chaos: number
  seed: number
  faults: Record<FaultKey, boolean>
}

export const DEFAULTS: Controls = {
  chaos: 40,
  seed: 42,
  faults: {
    timeout: true,
    error500: true,
    rateLimit: true,
    malformedJson: true,
    empty: true,
    injection: true,
    latency: true,
  },
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function parseHash(hash: string): Controls | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const controls: Controls = {
    chaos: DEFAULTS.chaos,
    seed: DEFAULTS.seed,
    faults: { ...DEFAULTS.faults },
  }
  if (params.has('chaos')) controls.chaos = clampInt(params.get('chaos'), 0, 100, DEFAULTS.chaos)
  if (params.has('seed')) {
    controls.seed = clampInt(params.get('seed'), 0, 0xffffffff, DEFAULTS.seed)
  }
  for (const key of FAULT_KEYS) {
    if (params.has(key)) controls.faults[key] = params.get(key) !== '0'
  }
  return controls
}

export function encodeHash(controls: Controls): string {
  const params = new URLSearchParams()
  params.set('chaos', String(controls.chaos))
  params.set('seed', String(controls.seed))
  for (const key of FAULT_KEYS) {
    params.set(key, controls.faults[key] ? '1' : '0')
  }
  return params.toString()
}
