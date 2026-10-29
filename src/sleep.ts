const RESET_MESSAGE = 'agent-chaos: call cancelled by reset'

/** Internal signal for a delay cleared by `reset()`. Not a simulated fault. */
export class DelayCancelled extends Error {
  constructor() {
    super(RESET_MESSAGE)
    this.name = 'DelayCancelled'
  }
}

interface PendingDelay {
  timer: ReturnType<typeof setTimeout>
  reject: (error: DelayCancelled) => void
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as { unref?: () => void }
  candidate.unref?.()
}

/**
 * Delays owned by one chaos bag.
 * `cancel` clears every timer and rejects the sleep so a reset cannot leak a timeout
 * or leave the in-flight call hanging.
 */
export function createDelays(): {
  sleep: (ms: number) => Promise<void>
  cancel: () => void
} {
  const pending = new Set<PendingDelay>()

  function sleep(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const item: PendingDelay = {
        timer: setTimeout(() => {
          pending.delete(item)
          resolve()
        }, ms),
        reject,
      }
      unref(item.timer)
      pending.add(item)
    })
  }

  function cancel(): void {
    const queued = [...pending]
    pending.clear()
    for (const item of queued) {
      clearTimeout(item.timer)
      item.reject(new DelayCancelled())
    }
  }

  return { sleep, cancel }
}
