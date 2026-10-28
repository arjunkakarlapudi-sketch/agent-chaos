import { faultsFromLevel, runDemo, usageSnippet, type AgentId, type AgentOutcome, type TraceRow } from './demo'
import { DEFAULTS, encodeHash, parseHash, type Controls, type FaultKey } from './hash'
import './style.css'

const chaosInput = must<HTMLInputElement>('chaos')
const chaosOut = must<HTMLOutputElement>('chaos-out')
const seedInput = must<HTMLInputElement>('seed')
const shuffleButton = must<HTMLButtonElement>('shuffle')
const runButton = must<HTMLButtonElement>('run')
const copyButton = must<HTMLButtonElement>('copy')
const snippet = must<HTMLElement>('snippet')
const status = must<HTMLElement>('status')
const live = must<HTMLElement>('live')
const toggles = [...document.querySelectorAll<HTMLButtonElement>('.toggle')]

let running = false
let ran = false

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
    num.textContent = '–'
    num.dataset.state = 'idle'
    meta.textContent = 'Not run'
    return
  }
  num.textContent = String(outcome.score)
  num.dataset.state = scoreState(outcome.score)
  meta.textContent = `${outcome.steps}/4 steps · ${outcome.unhandled} unhandled`
}

function clearTrace(agent: AgentId): void {
  const list = must<HTMLOListElement>(`trace-${agent}`)
  list.replaceChildren()
  const empty = document.createElement('li')
  empty.className = 'empty'
  empty.textContent = agent === 'naive' ? 'Hit Run. Each tool call lands here.' : 'Retries show up as their own rows.'
  list.append(empty)
}

function appendRow(agent: AgentId, row: TraceRow): void {
  const list = must<HTMLOListElement>(`trace-${agent}`)
  list.querySelector('.empty')?.remove()
  const item = document.createElement('li')
  item.className = 'row'

  const tool = document.createElement('span')
  tool.className = 'tool'
  tool.textContent = row.tool

  const pill = document.createElement('span')
  pill.className = 'pill'
  pill.dataset.status = row.status
  pill.textContent = row.status

  const detail = document.createElement('span')
  detail.className = 'detail'
  detail.textContent = row.detail

  item.append(tool, pill, detail)
  list.append(item)
}

function setBusy(busy: boolean): void {
  running = busy
  runButton.disabled = busy
  shuffleButton.disabled = busy
  copyButton.disabled = busy
  chaosInput.disabled = busy
  seedInput.disabled = busy
  for (const toggle of toggles) toggle.disabled = busy
  runButton.textContent = busy ? 'Running' : ran ? 'Run again' : 'Run'
  document.getElementById('main')?.setAttribute('aria-busy', busy ? 'true' : 'false')
}

function invalidate(): void {
  if (running || !ran) return
  ran = false
  setScore('naive', null)
  setScore('hardened', null)
  clearTrace('naive')
  clearTrace('hardened')
  status.textContent = 'Settings changed. Run again.'
  live.textContent = status.textContent
  runButton.textContent = 'Run'
}

async function run(): Promise<void> {
  const controls = readControls()
  if (!controls || running) return
  writeHash(controls)
  setBusy(true)
  ran = true
  setScore('naive', null)
  setScore('hardened', null)
  clearTrace('naive')
  clearTrace('hardened')
  status.textContent = 'Running the naive agent…'
  live.textContent = status.textContent
  try {
    await runDemo({
      seed: controls.seed,
      faults: faultsFromLevel(controls.chaos, controls.faults),
      alive: () => running,
      onRow: (agent, row) => {
        appendRow(agent, row)
        if (agent === 'hardened' && status.textContent?.startsWith('Running the naive')) {
          status.textContent = 'Running the hardened agent…'
          live.textContent = status.textContent
        }
      },
      onScore: (agent, outcome) => {
        setScore(agent, outcome)
        live.textContent = `${agent} score ${outcome.score}`
      },
    })
    const naive = must<HTMLElement>('score-naive').textContent
    const hardened = must<HTMLElement>('score-hardened').textContent
    status.textContent = `Naive ${naive} · Hardened ${hardened}`
    live.textContent = `Run finished. Naive ${naive}. Hardened ${hardened}. Seed ${controls.seed}.`
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'The run failed.'
    live.textContent = status.textContent
  } finally {
    setBusy(false)
  }
}

function onControlsChanged(): void {
  const controls = readControls()
  paintChaos()
  if (!controls) return
  snippet.textContent = usageSnippet(controls.seed)
  writeHash(controls)
  invalidate()
}

chaosInput.addEventListener('input', onControlsChanged)
seedInput.addEventListener('input', onControlsChanged)
seedInput.addEventListener('change', () => {
  if (readControls()) return
  seedInput.value = String(DEFAULTS.seed)
  onControlsChanged()
})

for (const toggle of toggles) {
  toggle.addEventListener('click', () => {
    const on = toggle.getAttribute('aria-pressed') !== 'true'
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false')
    toggle.classList.toggle('is-on', on)
    onControlsChanged()
  })
}

shuffleButton.addEventListener('click', () => {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  seedInput.value = String(buf[0]! % 1_000_000_000)
  onControlsChanged()
})

runButton.addEventListener('click', () => {
  void run()
})

copyButton.addEventListener('click', async () => {
  const text = snippet.textContent ?? ''
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  copyButton.textContent = 'Copied'
  window.setTimeout(() => {
    copyButton.textContent = 'Copy'
  }, 1200)
})

window.addEventListener('hashchange', () => {
  if (running) return
  const parsed = parseHash(location.hash)
  if (!parsed) return
  applyControls(parsed)
  invalidate()
  void run()
})

const boot = parseHash(location.hash) ?? DEFAULTS
applyControls(boot)
writeHash(boot)

if (parseHash(location.hash)) {
  void run()
}
