import { describe, expect, it } from 'vitest'
import {
  ChaosHttpError,
  INJECTION_MARKER,
  INJECTION_PAYLOAD,
  ResilienceError,
  TimeoutError,
  assertResilient,
  chaos,
  containsInjection,
} from '../src/index.js'

const none = { timeout: 0, error500: 0, rateLimit: 0, malformedJson: 0, empty: 0, injection: 0 }

async function sequence(seed: number): Promise<string[]> {
  const bag = chaos(
    {
      ping: async () => ({ ok: true, note: 'hi' }),
    },
    {
      seed,
      timeoutMs: 0,
      faults: {
        timeout: 0.2,
        error500: 0.15,
        rateLimit: 0.1,
        malformedJson: 0.1,
        empty: 0.1,
        injection: 0.1,
        latency: { p: 0.4, ms: [0, 0] },
      },
    },
  )
  const lines: string[] = []
  for (let i = 0; i < 24; i++) {
    try {
      await bag.ping()
    } catch {
      // Faults throw on purpose.
    }
  }
  for (const call of bag.__chaos.report().calls) {
    lines.push(
      `${call.fault ?? '-'}|${call.latency}|${call.latencyMs}|${call.outcome}|${call.injection}|${call.error?.status ?? ''}`,
    )
  }
  return lines
}

describe('chaos', () => {
  it('preserves tool types, name, and happy-path results', async () => {
    const search = async (query: string, limit = 3) => {
      return { query, hits: ['a', 'b', 'c'].slice(0, limit) }
    }
    const bag = chaos({ search }, { seed: 1, faults: none })
    const typed: (query: string, limit?: number) => Promise<{ query: string; hits: string[] }> =
      bag.search
    expect(bag.search.name).toBe('search')
    expect(Object.keys(bag)).toEqual(['search'])
    expect('__chaos' in { ...bag }).toBe(false)
    await expect(typed('tokyo', 1)).resolves.toEqual({ query: 'tokyo', hits: ['a'] })
    expect(bag.__chaos.report().calls[0]).toMatchObject({
      tool: 'search',
      args: ['tokyo', 1],
      fault: null,
      outcome: 'ok',
      handled: true,
    })

    // @ts-expect-error query is a string, not a number
    await bag.search(1)
  })

  it('wraps synchronous tools in a promise', async () => {
    const bag = chaos({ ping: () => 'ok' }, { seed: 1 })
    const pending = bag.ping()
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toBe('ok')
  })

  it('replays a seed and diverges on a different seed', async () => {
    const first = await sequence(42)
    const second = await sequence(42)
    const other = await sequence(7)
    expect(second).toEqual(first)
    expect(other).not.toEqual(first)
    expect(first.some((line) => !line.startsWith('-'))).toBe(true)
  })

  it('uses seed 1 when the seed is omitted', async () => {
    const implicit = chaos({ ping: async () => 1 }, { faults: { empty: 0.5 } })
    const explicit = chaos({ ping: async () => 1 }, { seed: 1, faults: { empty: 0.5 } })
    const read = async (bag: typeof implicit) => {
      const faults: Array<string | null> = []
      for (let i = 0; i < 8; i++) faults.push((await bag.ping(), bag.__chaos.report().calls[i]!.fault))
      return faults
    }
    expect(await read(implicit)).toEqual(await read(explicit))
    expect(implicit.__chaos.seed).toBe(1)
  })

  it('reset rewinds the report and the PRNG', async () => {
    const bag = chaos({ ping: async () => 'ok' }, { seed: 3, faults: { empty: 0.5 } })
    await bag.ping()
    await bag.ping()
    const before = bag.__chaos.report().calls.map((call) => call.fault)
    bag.__chaos.reset()
    expect(bag.__chaos.report().calls).toEqual([])
    await bag.ping()
    await bag.ping()
    expect(bag.__chaos.report().calls.map((call) => call.fault)).toEqual(before)
  })

  it('throws TimeoutError after the configured delay and skips the real tool', async () => {
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return 'ok'
        },
      },
      { seed: 1, faults: { timeout: 1 }, timeoutMs: 15 },
    )
    const started = performance.now()
    await expect(bag.ping()).rejects.toBeInstanceOf(TimeoutError)
    expect(performance.now() - started).toBeGreaterThanOrEqual(10)
    expect(calls).toBe(0)
    const call = bag.__chaos.report().calls[0]!
    expect(call).toMatchObject({ fault: 'timeout', outcome: 'thrown', handled: false })
    expect(call.error?.name).toBe('TimeoutError')
    expect(bag.__chaos.report().totals.byType.timeout).toBe(1)
  })

  it('throws HTTP 500', async () => {
    const seen: string[] = []
    const bag = chaos(
      { ping: async () => 'ok' },
      {
        seed: 1,
        faults: { error500: 1 },
        onFault: (event) => seen.push(event.type),
      },
    )
    await expect(bag.ping()).rejects.toMatchObject({ status: 500, name: 'ChaosHttpError' })
    expect(seen).toEqual(['error500'])
    expect(bag.__chaos.report().totals.byType.error500).toBe(1)
  })

  it('throws 429 with retry-after and does not call the tool', async () => {
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return 'ok'
        },
      },
      { seed: 4, faults: { rateLimit: 1 } },
    )
    try {
      await bag.ping()
      expect.fail('expected a rate limit')
    } catch (error) {
      expect(error).toBeInstanceOf(ChaosHttpError)
      const http = error as ChaosHttpError
      expect(http.status).toBe(429)
      expect(http.retryAfter).toBeGreaterThanOrEqual(1)
      expect(http.retryAfter).toBeLessThanOrEqual(3)
    }
    expect(calls).toBe(0)
    expect(bag.__chaos.report().calls[0]?.error?.retryAfter).toBeGreaterThanOrEqual(1)
  })

  it('returns truncated JSON and skips the real tool', async () => {
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return { ok: true }
        },
      },
      { seed: 1, faults: { malformedJson: 1 } },
    )
    const result = await bag.ping()
    expect(typeof result).toBe('string')
    if (typeof result !== 'string') throw new Error('expected a string')
    expect(() => JSON.parse(result)).toThrow()
    expect(calls).toBe(0)
    expect(bag.__chaos.report().calls[0]).toMatchObject({
      fault: 'malformedJson',
      outcome: 'returned',
    })
  })

  it('returns null for an empty fault', async () => {
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return { ok: true }
        },
      },
      { seed: 1, faults: { empty: 1 } },
    )
    await expect(bag.ping()).resolves.toBeNull()
    expect(calls).toBe(0)
    expect(bag.__chaos.report().totals.byTool.ping).toEqual({ calls: 1, faults: 1 })
  })

  it('appends a marked injection payload without mutating the tool result', async () => {
    const original = { summary: 'Clear', tags: ['a'], n: 1 }
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return original
        },
      },
      { seed: 1, faults: { injection: 1 } },
    )
    const result = await bag.ping()
    expect(calls).toBe(1)
    expect(original).toEqual({ summary: 'Clear', tags: ['a'], n: 1 })
    expect(result).toEqual({
      summary: `Clear${INJECTION_PAYLOAD}`,
      tags: [`a${INJECTION_PAYLOAD}`],
      n: 1,
    })
    expect(containsInjection(result)).toBe(true)
    expect(String(result && typeof result === 'object' && 'summary' in result ? result.summary : '')).toContain(
      'IGNORE PREVIOUS INSTRUCTIONS',
    )
    expect(result).toMatchObject({ summary: expect.stringContaining(INJECTION_MARKER) })
    const call = bag.__chaos.report().calls[0]!
    expect(call.injection).toBe(true)
    expect(call.fault).toBe('injection')
    expect(bag.__chaos.report().totals.byType.injection).toBe(1)
  })

  it('turns a stringless result into text plus the fixture', async () => {
    const bag = chaos({ ping: async () => 1 }, { seed: 1, faults: { injection: 1 } })
    await expect(bag.ping()).resolves.toBe(`1${INJECTION_PAYLOAD}`)
  })

  it('adds latency and still returns the real value', async () => {
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return 'ok'
        },
      },
      { seed: 1, faults: { latency: { p: 1, ms: [20, 20] } } },
    )
    const started = performance.now()
    await expect(bag.ping()).resolves.toBe('ok')
    expect(performance.now() - started).toBeGreaterThanOrEqual(15)
    expect(calls).toBe(1)
    expect(bag.__chaos.report().calls[0]).toMatchObject({
      fault: null,
      latency: true,
      latencyMs: 20,
      outcome: 'ok',
      handled: true,
    })
    expect(bag.__chaos.report().totals.byType.latency).toBe(1)
    expect(bag.__chaos.report().totals.unhandled).toBe(0)
  })

  it('stacks latency in front of an empty fault and notifies both', async () => {
    const seen: string[] = []
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return 'ok'
        },
      },
      {
        seed: 1,
        faults: { empty: 1, latency: { p: 1, ms: [0, 0] } },
        onFault: (event) => seen.push(event.type),
      },
    )
    await expect(bag.ping()).resolves.toBeNull()
    expect(calls).toBe(0)
    expect(seen).toEqual(['latency', 'empty'])
    expect(bag.__chaos.report().totals.byType).toMatchObject({ empty: 1, latency: 1 })
  })

  it('ignores a throwing onFault listener', async () => {
    const bag = chaos(
      { ping: async () => 'ok' },
      {
        seed: 1,
        faults: { empty: 1 },
        onFault: () => {
          throw new Error('listener failed')
        },
      },
    )
    await expect(bag.ping()).resolves.toBeNull()
  })

  it('records a real tool exception separately from injected faults', async () => {
    const bag = chaos(
      {
        ping: async () => {
          throw new Error('boom')
        },
      },
      { seed: 1, faults: none },
    )
    await expect(bag.ping()).rejects.toThrow('boom')
    expect(bag.__chaos.report().calls[0]).toMatchObject({
      fault: null,
      outcome: 'thrown',
      handled: false,
      error: { name: 'Error', message: 'boom' },
    })
  })

  it('rejects bad tool bags', () => {
    expect(() => chaos(null as unknown as Record<string, never>)).toThrow(TypeError)
    expect(() => chaos({ ping: 1 as unknown as () => void })).toThrow(/not a function/)
    expect(() => chaos({ __chaos: async () => 1 })).toThrow(/reserved/)
  })

  it('splits totals across tools', async () => {
    const bag = chaos(
      {
        a: async () => 'a',
        b: async () => 'b',
      },
      { seed: 1, faults: { empty: 1 } },
    )
    await bag.a()
    await bag.b()
    const report = bag.__chaos.report()
    expect(report.totals.calls).toBe(2)
    expect(report.totals.byTool).toEqual({
      a: { calls: 1, faults: 1 },
      b: { calls: 1, faults: 1 },
    })
    expect(report.seed).toBe(1)
  })
})

describe('assertResilient', () => {
  it('fails while a result fault is unhandled, then passes once it is marked', async () => {
    const bag = chaos({ ping: async () => 'ok' }, { seed: 1, faults: { empty: 1 } })
    await bag.ping()
    expect(() => assertResilient(bag.__chaos.report(), { maxUnhandled: 0 })).toThrow(ResilienceError)
    expect(() => assertResilient(bag.__chaos.report(), { maxUnhandled: 1 })).not.toThrow()
    bag.__chaos.markHandled()
    expect(() => assertResilient(bag.__chaos.report(), { maxUnhandled: 0 })).not.toThrow()
  })

  it('does not count latency-only calls as unhandled', async () => {
    const bag = chaos(
      { ping: async () => 'ok' },
      { seed: 1, faults: { latency: { p: 1, ms: [0, 0] } } },
    )
    await bag.ping()
    assertResilient(bag.__chaos.report(), { maxUnhandled: 0 })
  })

  it('rejects an unknown call id and an empty report mark', () => {
    const bag = chaos({ ping: async () => 'ok' }, { seed: 1 })
    expect(() => bag.__chaos.markHandled()).toThrow(/no call/)
    expect(() => bag.__chaos.markHandled(4)).toThrow(/no call 4/)
  })

  it('passes a report with no calls', () => {
    const bag = chaos({ ping: async () => 'ok' }, { seed: 1 })
    assertResilient(bag.__chaos.report(), { maxUnhandled: 0 })
  })
})
