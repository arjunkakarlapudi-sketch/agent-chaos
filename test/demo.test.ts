import { describe, expect, it } from 'vitest'
import type { FaultRates } from 'agent-chaos'
import {
  faultsFromLevel,
  runDemo,
  type AgentId,
  type AgentOutcome,
  type DemoTiming,
  type StepReport,
} from '../playground/src/demo.js'
import { DEFAULTS, type FaultKey } from '../playground/src/hash.js'
import { chaos } from '../src/index.js'

const FAST: DemoTiming = { timeoutMs: 0, paceMs: 0, backoffBaseMs: 0, retryAfterUnitMs: 0 }
const enabled = { ...DEFAULTS.faults }

async function collect(seed: number, level: number, faults?: FaultRates) {
  const steps: Array<{ agent: AgentId; step: StepReport }> = []
  const scores: Partial<Record<AgentId, AgentOutcome>> = {}
  await runDemo({
    seed,
    faults: faults ?? faultsFromLevel(level, enabled, [0, 0]),
    timing: FAST,
    onStep: (agent, step) => steps.push({ agent, step }),
    onScore: (agent, outcome) => {
      scores[agent] = outcome
    },
  })
  return { steps, naive: scores.naive!, hardened: scores.hardened! }
}

function reactions(result: Awaited<ReturnType<typeof collect>>, agent: AgentId): string[] {
  return result.steps.filter((row) => row.agent === agent).map((row) => row.step.reaction)
}

describe('playground chaos level', () => {
  it('makes the slider the share of calls that fault', async () => {
    async function rate(level: number): Promise<number> {
      const faults = faultsFromLevel(level, enabled, [0, 0])
      const bag = chaos({ ping: async () => 'ok' }, { seed: 42, faults, timeoutMs: 0 })
      let hits = 0
      const n = 800
      for (let i = 0; i < n; i += 1) {
        try {
          await bag.ping()
        } catch {
          // A fault throwing is still a hit.
        }
        if (bag.__chaos.report().calls[i]?.fault) hits += 1
      }
      return hits / n
    }

    expect(await rate(0)).toBe(0)
    const r25 = await rate(25)
    const r50 = await rate(50)
    const r75 = await rate(75)
    expect(await rate(100)).toBe(1)
    expect(r25).toBeGreaterThan(0.15)
    expect(r25).toBeLessThan(0.35)
    expect(r50).toBeGreaterThan(r25)
    expect(r75).toBeGreaterThan(r50)
    expect(r75).toBeLessThan(0.9)
  })

  it('faults every call with the one enabled fault at 100%', async () => {
    const onlyTimeout: Record<FaultKey, boolean> = {
      timeout: true,
      error500: false,
      rateLimit: false,
      malformedJson: false,
      empty: false,
      injection: false,
      latency: false,
    }
    const faults = faultsFromLevel(100, onlyTimeout, [0, 0])
    expect(faults.timeout).toBe(1)
    expect(faults.injection).toBe(0)
    const result = await collect(1, 100, faults)
    expect(reactions(result, 'naive')).toEqual(['crashed', 'crashed', 'crashed', 'crashed'])
    expect(result.naive.score).toBe(0)
    expect(result.naive.unhandled).toBe(4)
    expect(reactions(result, 'hardened').every((reaction) => reaction === 'retried, then stopped')).toBe(true)
    expect(result.steps.filter((row) => row.agent === 'hardened').every((row) => row.step.detail.includes('backed off'))).toBe(true)
    expect(result.hardened.unhandled).toBe(0)
  })
})

describe('playground agents', () => {
  it('shows the naive agent follow an injection and the hardened agent ignore it', async () => {
    const result = await collect(3, 100, { injection: 1, latency: { p: 0, ms: [0, 0] } })
    expect(reactions(result, 'naive')).toEqual([
      'followed the injected instruction',
      'followed the injected instruction',
      'followed the injected instruction',
      'followed the injected instruction',
    ])
    expect(reactions(result, 'hardened')).toEqual([
      'ignored the injection',
      'ignored the injection',
      'ignored the injection',
      'ignored the injection',
    ])
    expect(result.naive.score).toBe(0)
    expect(result.hardened.score).toBe(100)
    expect(result.naive.unhandled).toBe(4)
    expect(result.hardened.unhandled).toBe(0)
    expect(result.hardened.report.calls.every((call) => call.injection && call.handled)).toBe(true)
  })

  it('honors retry-after on a 429 and does not invent a successful booking', async () => {
    const result = await collect(4, 100, { rateLimit: 1, latency: { p: 0, ms: [0, 0] } })
    expect(result.naive.score).toBe(0)
    expect(result.hardened.score).toBe(0)
    const hardened = result.steps.filter((row) => row.agent === 'hardened')
    expect(hardened.every((row) => row.step.reaction === 'retried, then stopped')).toBe(true)
    expect(hardened.every((row) => /honored retry-after [123]s/.test(row.step.detail))).toBe(true)
    expect(result.hardened.unhandled).toBe(0)
    expect(result.naive.unhandled).toBe(4)
  })

  it('rejects bad JSON and empty payloads instead of crashing', async () => {
    const bad = await collect(1, 100, { malformedJson: 1, latency: { p: 0, ms: [0, 0] } })
    expect(reactions(bad, 'naive').every((reaction) => reaction === 'crashed')).toBe(true)
    expect(bad.steps.filter((row) => row.agent === 'hardened').every((row) => row.step.detail.includes('rejected bad JSON'))).toBe(true)
    const empty = await collect(1, 100, { empty: 1, latency: { p: 0, ms: [0, 0] } })
    expect(empty.steps.filter((row) => row.agent === 'naive').every((row) => row.step.detail === 'empty result')).toBe(true)
    expect(empty.steps.filter((row) => row.agent === 'hardened').every((row) => row.step.detail.includes('empty result'))).toBe(true)
    expect(empty.hardened.score).toBe(0)
  })

  it('seed 42 scores move as chaos rises, and hardened stays ahead', async () => {
    const table: number[][] = []
    for (const level of [0, 25, 40, 50, 75, 100]) {
      const row = await collect(42, level)
      table.push([level, row.naive.score, row.naive.unhandled, row.hardened.score, row.hardened.unhandled])
    }
    expect(table).toEqual([
      [0, 100, 0, 100, 0],
      [25, 50, 2, 100, 0],
      [40, 50, 2, 75, 0],
      [50, 50, 2, 75, 0],
      [75, 0, 4, 50, 0],
      [100, 0, 4, 25, 0],
    ])
    const high = await collect(42, 100)
    expect(reactions(high, 'hardened')).toContain('ignored the injection')
    expect(reactions(high, 'hardened')).toContain('retried, then stopped')
    expect(reactions(high, 'naive').every((reaction) => reaction === 'crashed')).toBe(true)
  })

  it('usually hurts more at 100% than at 40%, with hardened ahead', async () => {
    let ahead = 0
    let hurt = 0
    for (let seed = 1; seed <= 24; seed += 1) {
      const mid = await collect(seed, 40)
      const high = await collect(seed, 100)
      if (high.hardened.score >= high.naive.score && mid.hardened.score >= mid.naive.score) ahead += 1
      if (high.naive.score + high.hardened.score < mid.naive.score + mid.hardened.score) hurt += 1
    }
    expect(ahead).toBeGreaterThan(18)
    expect(hurt).toBeGreaterThan(18)
  })
})
