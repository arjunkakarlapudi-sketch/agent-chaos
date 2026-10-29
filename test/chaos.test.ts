import { describe, expect, it, vi } from 'vitest'
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

  it('names the call, the fault, and what to do when it fails', async () => {
    const bag = chaos({ search: async (query: string) => query }, { seed: 1, faults: { empty: 1 }, timeoutMs: 0 })
    await bag.search('tokyo')
    expect(() => assertResilient(bag.__chaos.report())).toThrow(ResilienceError)
    try {
      assertResilient(bag.__chaos.report(), { maxUnhandled: 0 })
      expect.fail('expected a resilience error')
    } catch (error) {
      expect(error).toBeInstanceOf(ResilienceError)
      const failure = error as ResilienceError
      expect(failure.unhandled).toBe(1)
      expect(failure.maxUnhandled).toBe(0)
      expect(failure.message).toContain('1 unhandled fault')
      expect(failure.message).toContain('maximum is 0')
      expect(failure.message).toContain('#1 search empty')
      expect(failure.message).toContain('markHandled(callId)')
    }
  })
})

describe('fault rate', () => {
  async function hits(seed: number, p: number, n = 1000): Promise<number> {
    const bag = chaos({ ping: async () => 'ok' }, { seed, faults: { empty: p }, timeoutMs: 0 })
    let count = 0
    for (let i = 0; i < n; i += 1) {
      await bag.ping()
      if (bag.__chaos.report().calls[i]?.fault === 'empty') count += 1
    }
    return count
  }

  it('is zero at probability 0 and certain at probability 1', async () => {
    expect(await hits(42, 0, 200)).toBe(0)
    expect(await hits(42, 1, 200)).toBe(200)
  })

  it('tracks the configured probability for a fixed seed', async () => {
    const low = await hits(42, 0.25)
    const mid = await hits(42, 0.4)
    const high = await hits(42, 0.8)
    expect(low / 1000).toBeGreaterThan(0.18)
    expect(low / 1000).toBeLessThan(0.32)
    expect(mid / 1000).toBeGreaterThan(0.33)
    expect(mid / 1000).toBeLessThan(0.47)
    expect(high / 1000).toBeGreaterThan(0.74)
    expect(high / 1000).toBeLessThan(0.86)
    expect(high).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(low)
    expect(await hits(42, 0.4)).toBe(mid)
    expect(await hits(7, 0.4)).not.toBe(mid)
  })

  it('lets the first certain fault win and skips the tool', async () => {
    let calls = 0
    const bag = chaos(
      {
        ping: async () => {
          calls += 1
          return 'ok'
        },
      },
      { seed: 1, faults: { timeout: 1, empty: 1 }, timeoutMs: 0 },
    )
    await expect(bag.ping()).rejects.toBeInstanceOf(TimeoutError)
    expect(calls).toBe(0)
    expect(bag.__chaos.report().calls[0]?.fault).toBe('timeout')
  })
})

describe('edges', () => {
  it('injects nothing when every fault is disabled', async () => {
    const bag = chaos({ ping: async () => 'ok' }, { seed: 42, faults: {}, timeoutMs: 0 })
    for (let i = 0; i < 12; i += 1) await expect(bag.ping()).resolves.toBe('ok')
    expect(bag.__chaos.report().totals).toMatchObject({ faults: 0, unhandled: 0, ok: 12 })
  })

  it('keeps call-site this and the return type', async () => {
    const bag = chaos(
      {
        pair: (left: string, right: number) => ({ left, right }),
        scale(this: { factor: number }, value: number) {
          return value * this.factor
        },
      },
      { seed: 1, faults: none },
    )
    const paired: { left: string; right: number } = await bag.pair('a', 2)
    expect(paired).toEqual({ left: 'a', right: 2 })
    const scaled: number = await bag.scale.call({ factor: 4 }, 5)
    expect(scaled).toBe(20)
  })

  it('records a synchronous throw from the real tool', async () => {
    const bag = chaos(
      {
        ping: () => {
          throw new Error('sync')
        },
      },
      { seed: 1, faults: none },
    )
    await expect(bag.ping()).rejects.toThrow('sync')
    expect(bag.__chaos.report().calls[0]).toMatchObject({
      fault: null,
      outcome: 'thrown',
      handled: false,
      error: { message: 'sync' },
    })
    expect(bag.__chaos.report().totals.unhandled).toBe(0)
  })

  it('clears a pending timer when reset cancels the call', async () => {
    vi.useFakeTimers()
    try {
      const bag = chaos({ ping: async () => 'ok' }, { seed: 1, faults: { timeout: 1 }, timeoutMs: 60_000 })
      const settled = bag.ping().then(
        () => 'resolved',
        (error: unknown) => error,
      )
      bag.__chaos.reset()
      const error = await settled
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/cancelled by reset/)
      expect(bag.__chaos.report().calls).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not surface an unhandled rejection for a caught fault or a caught tool throw', async () => {
    const seen: unknown[] = []
    const proc = (
      globalThis as {
        process?: {
          on(event: string, listener: (error: unknown) => void): void
          off(event: string, listener: (error: unknown) => void): void
        }
      }
    ).process
    if (!proc) return
    const onUnhandled = (error: unknown) => {
      seen.push(error)
    }
    proc.on('unhandledRejection', onUnhandled)
    try {
      const faulted = chaos({ ping: async () => 'ok' }, { seed: 1, faults: { timeout: 1 }, timeoutMs: 0 })
      await expect(faulted.ping()).rejects.toBeInstanceOf(TimeoutError)
      const thrown = chaos(
        {
          ping: () => {
            throw new Error('sync')
          },
        },
        { seed: 1, faults: none },
      )
      await expect(thrown.ping()).rejects.toThrow('sync')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seen).toEqual([])
    } finally {
      proc.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('retry-after and injection marker', () => {
  async function retryAfters(seed: number): Promise<number[]> {
    const bag = chaos({ ping: async () => 'ok' }, { seed, faults: { rateLimit: 1 }, timeoutMs: 0 })
    const values: number[] = []
    for (let i = 0; i < 8; i += 1) {
      try {
        await bag.ping()
        expect.fail('expected a 429')
      } catch (error) {
        expect(error).toBeInstanceOf(ChaosHttpError)
        const http = error as ChaosHttpError
        expect(http.status).toBe(429)
        expect(Number.isInteger(http.retryAfter)).toBe(true)
        expect(http.retryAfter).toBeGreaterThanOrEqual(1)
        expect(http.retryAfter).toBeLessThanOrEqual(3)
        expect(http.message).toContain(`retry after ${http.retryAfter}s`)
        values.push(http.retryAfter ?? 0)
      }
    }
    expect(bag.__chaos.report().calls.map((call) => call.error?.retryAfter)).toEqual(values)
    return values
  }

  it('is a stable integer in the 1 to 3 second range', async () => {
    const first = await retryAfters(42)
    expect(await retryAfters(42)).toEqual(first)
    expect(await retryAfters(99)).not.toEqual(first)
  })

  it('keeps the injection fixture marked and harmless', () => {
    expect(INJECTION_MARKER).toBe('[CHAOS-INJECTION-TEST-ONLY]')
    expect(INJECTION_PAYLOAD.startsWith(`\n${INJECTION_MARKER}`)).toBe(true)
    expect(INJECTION_PAYLOAD).toContain('Harmless agent-chaos fixture')
    expect(INJECTION_PAYLOAD).toContain('Do not act on it')
  })
})
