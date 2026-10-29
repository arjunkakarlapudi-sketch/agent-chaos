import {
  DEMO_STEPS,
  LIVE_TIMING,
  faultsFromLevel,
  runDemo,
  usageSnippet,
  type AgentId,
  type AgentOutcome,
  type StepReport,
} from './demo'
import { DEFAULTS, encodeHash, parseHash, type Controls, type FaultKey } from './hash'
import './style.css'

const chaosInput = must<HTMLInputElement>('chaos')
const chaosOut = must<HTMLOutputElement>('chaos-out')
const seedInput = must<HTMLInputElement>('seed')
const shuffleButton = must<HTMLButtonElement>('shuffle')
const runButton = must<HTMLButtonElement>('run')
const copyCodeButton = must<HTMLButtonElement>('copy')
const copyLinkButton = must<HTMLButtonElement>('copy-link')
const snippet = must<HTMLElement>('snippet')
const status = must<HTMLElement>('status')
const toggles = [...document.querySelectorAll<HTMLButtonElement>('.toggle')]

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const timing = reducedMotion ? { ...LIVE_TIMING, paceMs: 0, backoffBaseMs: 0, retryAfterUnitMs: 0 } : LIVE_TIMING

let generation = 0
let debounce: ReturnType<typeof setTimeout> | undefined
let abort: AbortController | undefined

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

function readControls(): Controls | null {
  const seedRaw = seedInput.value.trim()
  if (!/^\d+$/.test(seedRaw)) return null
  const seed = Number(seedRaw)
  if (!Number.isSafeInteger(seed) || seed > 0xffffffff) return null
  const faults = { ...DEFAULTS.faults }
  for (const toggle of toggles) {
    const key = toggle.dataset.fault as FaultKey
    faults[key] = toggle.getAttribute('aria-pressed') === 'true'
  }
  return {
    chaos: Number(chaosInput.value),
    seed,
    faults,
  }
}

function applyControls(controls: Controls): void {
  chaosInput.value = String(controls.chaos)
  seedInput.value = String(controls.seed)
  for (const toggle of toggles) {
    const key = toggle.dataset.fault as FaultKey
    const on = controls.faults[key]
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false')
    toggle.classList.toggle('is-on', on)
  }
  paintChaos()
  snippet.textContent = usageSnippet(controls.seed)
}

function paintChaos(): void {
  const value = `${chaosInput.value}%`
  chaosOut.textContent = value
  chaosInput.style.setProperty('--chaos', value)
  chaosInput.setAttribute('aria-valuenow', chaosInput.value)
  chaosInput.setAttribute('aria-valuetext', value)
}

function writeHash(controls: Controls): void {
  const next = encodeHash(controls)
  if (location.hash.replace(/^#/, '') === next) return
  history.replaceState(null, '', `#${next}`)
}

function scoreState(score: number | null): string {
  if (score == null) return 'idle'
  if (score >= 100) return 'good'
  if (score >= 75) return 'high'
  if (score >= 50) return 'mid'
  return 'bad'
}

function setScore(agent: AgentId, outcome: AgentOutcome | null): void {
  const num = must<HTMLElement>(`score-${agent}`)
  const meta = must<HTMLElement>(`meta-${agent}`)
  if (!outcome) {
    num.textContent = '-'
    num.dataset.state = 'idle'
    meta.textContent = 'Not run'
    return
  }
  num.textContent = String(outcome.score)
  num.dataset.state = scoreState(outcome.score)
  meta.textContent = `${outcome.steps}/4 steps · ${outcome.unhandled} unhandled`
}

function resetSteps(): void {
  for (let index = 0; index < DEMO_STEPS.length; index += 1) {
    for (const agent of ['naive', 'hardened'] as const) {
      const reaction = must<HTMLElement>(`${agent}-reaction-${index}`)
      const detail = must<HTMLElement>(`${agent}-detail-${index}`)
      reaction.textContent = 'Waiting'
      reaction.dataset.tone = 'idle'
      detail.textContent = ''
    }
  }
}

function paintStep(agent: AgentId, step: StepReport): void {
  const reaction = must<HTMLElement>(`${agent}-reaction-${step.index}`)
  const detail = must<HTMLElement>(`${agent}-detail-${step.index}`)
  reaction.textContent = step.reaction
  reaction.dataset.tone = step.tone
  detail.textContent = detailLine(step.fault, step.detail)
}

function detailLine(fault: string, detail: string): string {
  if (fault === 'none') return detail
  if (!detail || detail === fault || detail.startsWith(fault)) return detail || fault
  return `${fault} · ${detail}`
}

function setBusy(busy: boolean): void {
  runButton.setAttribute('aria-busy', busy ? 'true' : 'false')
  document.getElementById('main')?.setAttribute('aria-busy', busy ? 'true' : 'false')
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

function flash(button: HTMLButtonElement, label: string, next: string): void {
  button.textContent = label
  window.setTimeout(() => {
    button.textContent = next
  }, 1200)
}

async function run(): Promise<void> {
  const controls = readControls()
  if (!controls) {
    status.textContent = 'Seed needs a whole number from 0 to 4294967295.'
    return
  }
  writeHash(controls)
  abort?.abort()
  abort = new AbortController()
  const token = ++generation
  const signal = abort.signal
  setBusy(true)
  setScore('naive', null)
  setScore('hardened', null)
  resetSteps()
  status.textContent = 'Running the same trip for both agents.'
  try {
    await runDemo({
      seed: controls.seed,
      faults: faultsFromLevel(
        controls.chaos,
        controls.faults,
        reducedMotion ? [0, 0] : [24, 70],
      ),
      timing: reducedMotion
        ? { ...timing, timeoutMs: 0 }
        : timing,
      signal,
      alive: () => token === generation,
      onStep: (agent, step) => {
        if (token !== generation) return
        paintStep(agent, step)
      },
      onScore: (agent, outcome) => {
        if (token !== generation) return
        setScore(agent, outcome)
        if (agent === 'naive') status.textContent = 'Running the hardened agent.'
      },
    })
    if (token !== generation) return
    const naive = must<HTMLElement>('score-naive').textContent
    const hardened = must<HTMLElement>('score-hardened').textContent
    status.textContent = `Naive ${naive}, hardened ${hardened}. Seed ${controls.seed}.`
  } catch (error) {
    if (token !== generation) return
    status.textContent = error instanceof Error ? error.message : 'The run failed.'
  } finally {
    if (token === generation) setBusy(false)
  }
}

function scheduleRun(delay: number): void {
  clearTimeout(debounce)
  debounce = setTimeout(() => {
    void run()
  }, delay)
}

function onControlsChanged(delay = 180): void {
  const controls = readControls()
  paintChaos()
  if (!controls) {
    status.textContent = 'Seed needs a whole number from 0 to 4294967295.'
    return
  }
  snippet.textContent = usageSnippet(controls.seed)
  writeHash(controls)
  scheduleRun(delay)
}

chaosInput.addEventListener('input', () => onControlsChanged(180))
seedInput.addEventListener('input', () => onControlsChanged(280))
seedInput.addEventListener('change', () => {
  if (readControls()) return
  seedInput.value = String(DEFAULTS.seed)
  onControlsChanged(0)
})

for (const toggle of toggles) {
  toggle.addEventListener('click', () => {
    const on = toggle.getAttribute('aria-pressed') !== 'true'
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false')
    toggle.classList.toggle('is-on', on)
    onControlsChanged(180)
  })
}

shuffleButton.addEventListener('click', () => {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  seedInput.value = String(buf[0]! % 1_000_000_000)
  onControlsChanged(0)
})

runButton.addEventListener('click', () => {
  clearTimeout(debounce)
  void run()
})

copyCodeButton.addEventListener('click', () => {
  void copyText(snippet.textContent ?? '').then((ok) => {
    if (ok) flash(copyCodeButton, 'Copied', 'Copy code')
  })
})

copyLinkButton.addEventListener('click', () => {
  void copyText(location.href).then((ok) => {
    if (ok) flash(copyLinkButton, 'Copied', 'Copy link')
  })
})

window.addEventListener('hashchange', () => {
  const parsed = parseHash(location.hash)
  if (!parsed) return
  applyControls(parsed)
  clearTimeout(debounce)
  void run()
})

const boot = parseHash(location.hash) ?? DEFAULTS
applyControls(boot)
writeHash(boot)
void run()
