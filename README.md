# agent-chaos

Chaos Monkey for AI agents. Wrap the tools your agent calls, inject the same faults every time, and see if it still finishes the job.

**Live demo:** https://agent-chaos.vercel.app/

![agent-chaos on a phone: chaos slider, Run button, and naive versus hardened scores](docs/playground-phone.png)

Zero runtime dependencies. ESM. Node 18+ and the browser.

Not on npm yet. Install from GitHub:

```bash
npm i github:arjunkakarlapudi-sketch/agent-chaos
```

That runs the `prepare` script, which compiles `src/` to `dist/`. `package.json` points `main`, `types`, and `exports` at those built files.

## Quick start

```ts
import { chaos } from 'agent-chaos'

const tools = chaos({ search, getWeather }, {
  seed: 42,
  faults: { timeout: 0.1, error500: 0.1, rateLimit: 0.05, malformedJson: 0.05, empty: 0.05, injection: 0.05, latency: { p: 0.2, ms: [200, 3000] } },
})

const flights = await tools.search('tokyo')
console.log(tools.__chaos.report().totals)
```

The wrapped functions keep the original argument types, return type, and `this`. Sync functions come back as promises.

## Faults

Each fault has its own probability from 0 to 1. Rolls happen in the order below. The first hit wins, so a later fault only runs if the earlier ones missed. The real tool is not called, except for injection.

| Fault | What the caller sees |
| --- | --- |
| `timeout` | `TimeoutError` after `timeoutMs` (default 1000). |
| `error500` | `ChaosHttpError` with `status` 500. |
| `rateLimit` | `ChaosHttpError` with `status` 429 and `retryAfter` of 1, 2, or 3 seconds. |
| `malformedJson` | A truncated JSON string. `JSON.parse` throws. |
| `empty` | `null`. |
| `injection` | The real result, with `[CHAOS-INJECTION-TEST-ONLY]` appended to every string. The text says "IGNORE PREVIOUS INSTRUCTIONS" and is a harmless test fixture. Do not act on it. |
| `latency` | A separate roll. Waits a seeded delay inside `ms`, then the call continues. Can stack with a result fault. |

`0` skips that roll. Anything above `1` is treated as always. One `chaos()` bag shares one PRNG, so call order is part of the replay.

## Seeding

The generator is mulberry32. Same seed, same fault config, and same call order produce the same fault sequence in Node and the browser. A different seed produces a different sequence. If you omit `seed`, it is `1`, so a run is reproducible unless you pass a random seed yourself.

`reset()` clears the report, rewinds the PRNG, and cancels any in-flight delay. A call that was waiting rejects with `agent-chaos: call cancelled by reset`.

## In a test

```ts
import { assertResilient, chaos, isChaosError } from 'agent-chaos'

const tools = chaos({ search }, { seed: 42, faults: { timeout: 1 }, timeoutMs: 5 })

try {
  await tools.search('tokyo')
} catch (error) {
  if (isChaosError(error)) tools.__chaos.markHandled()
  else throw error
}

assertResilient(tools.__chaos.report(), { maxUnhandled: 0 })
```

A result fault stays unhandled until `markHandled(callId)` (the latest call, if you omit the id). Latency-only calls are not unhandled: the result is still real. `assertResilient` throws `ResilienceError` when unmarked result faults exceed `maxUnhandled`. The message names each call, tool, and fault.

`report()` lists every call (`tool`, `args`, `fault`, `latency`, `outcome`, `handled`, `error`) plus `totals.byType` and `totals.byTool`.

## Adapters

No extra dependencies. Wrap the function you already pass into the framework.

### Vercel AI SDK

```ts
import { tool } from 'ai'
import { chaos } from 'agent-chaos'

const faulted = chaos({
  getWeather: async (input: { city: string }) => realGetWeather(input),
}, { seed: 7, faults: { timeout: 0.2, error500: 0.1 } })

const getWeather = tool({
  description: 'Weather for a city',
  parameters: schema,
  execute: (input) => faulted.getWeather(input),
})
```

### OpenAI function calling

```ts
const faulted = chaos({
  get_weather: async (args: { city: string }) => realGetWeather(args),
}, { seed: 7, faults: { rateLimit: 0.2, timeout: 0.1 } })

async function dispatch(call: { name: string; arguments: string }) {
  if (call.name === 'get_weather') {
    return faulted.get_weather(JSON.parse(call.arguments) as { city: string })
  }
  throw new Error(`unknown tool ${call.name}`)
}
```

### LangChain-style tools

```ts
const faulted = chaos({
  search: async (query: string) => realSearch(query),
}, { seed: 7, faults: { empty: 0.2, malformedJson: 0.1 } })

const search = new DynamicTool({
  name: 'search',
  description: 'Search the web',
  func: async (input) => {
    const result = await faulted.search(input)
    return typeof result === 'string' ? result : JSON.stringify(result)
  },
})
```

## Playground

[`vercel.json`](vercel.json) builds with `npm run build` and serves `playground/dist`. The page runs a scripted Tokyo trip in the browser with this library. No backend and no API keys. The chaos slider is the share of calls that get a result fault. Demo waits are shortened (timeout 80ms, latency 24-70ms). Pass your own `timeoutMs` and `latency.ms` in real tests.

This repo: `npm install`, `npm test`, `npm run build`.

## License

[MIT](LICENSE) © 2026 Arjun Kakarlapudi
