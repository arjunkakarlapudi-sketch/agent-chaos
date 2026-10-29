import { describe, expect, it } from 'vitest'
import { DEFAULTS, encodeHash, parseHash } from '../playground/src/hash.js'

describe('hash', () => {
  it('round-trips the controls', () => {
    const controls = {
      chaos: 75,
      seed: 42,
      faults: { ...DEFAULTS.faults, injection: false, latency: false },
    }
    const parsed = parseHash(encodeHash(controls))
    expect(parsed).toEqual(controls)
  })

  it('falls back when the hash is empty or junk', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#')).toBeNull()
    const parsed = parseHash('#chaos=nope&seed=-4&timeout=0')
    expect(parsed?.chaos).toBe(DEFAULTS.chaos)
    expect(parsed?.seed).toBe(0)
    expect(parsed?.faults.timeout).toBe(false)
  })
})
