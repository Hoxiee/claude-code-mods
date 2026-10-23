import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'neo-statusline',
  component: 'PromptHint',
  requestId: 'hint',
  surface: 'terminal',
  props: { isDraft: false, isWorking: false, hint: 'bypass permissions on (shift+tab to cycle)' },
} as const

test('the band shows model, context, limits and cost', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.every', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/me/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '# branch.oid abcdef1234\n# branch.head main\n# branch.ab +2 -1\n1 .M N... 1 1 1 a b c\n? x\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 480_000, window: 1_000_000, percent: 48 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 35 }],
      cost: { usd: 1.234 },
    },
  }))
  on('clock.now', () => ({ value: 3_600_000 }))

  await $.session.start({ cwd: '/home/me/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /480k\/1M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$1\.23/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /bypass permissions on$/ })).toBeDefined()
  await ui.unmount()
})

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const usage = (fresh: number, read: number, write: number): Usage => ({
  input_tokens: fresh,
  output_tokens: 5,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

// A session the band can run in: one shared store (as the real one is), an id and a clock.
function world(on: Parameters<Parameters<typeof test>[1]>[1], opts: { store?: Map<string, unknown>; sid?: string; now?: number } = {}) {
  const store = opts.store ?? new Map<string, unknown>()
  const state = { sid: opts.sid ?? 's1', now: opts.now ?? 60_000, next: null as Usage | null }

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('clock.every', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: state.sid }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('clock.now', () => ({ value: state.now }))
  on('turn.step', async function* (_, e) {
    const usage = state.next && { ...state.next, model: e.model }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })

  return state
}

// Runs one request of the main thread (or a subagent's) that the API answered with `u`.
async function step($: Parameters<Parameters<typeof test>[1]>[0], w: { next: Usage | null }, u: Usage, agentId?: string) {
  w.next = u
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 2, agentId })
  for (;;) if ((await stream.next()).done) return
}

const mount = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.ui.mount({ ...BAND, props: { ...BAND.props, hint: '' } })

test('the band shows the last request\'s cache ratio, the session total and the countdown', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await step($, w, usage(10, 90, 0))
  const ui = await mount($)

  expect(await ui.find({ type: 'Text', text: /90%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5m\?/ })).toBeDefined()
  await ui.unmount()
})

test('the ratio is the last request\'s, not the turn\'s sum, and Σ is the whole session', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await step($, w, usage(100, 0, 9_900)) // cold start: nothing read
  await step($, w, usage(100, 9_900, 0)) // warm
  const ui = await mount($)

  expect(await ui.find({ type: 'Text', text: /99%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Σ50%/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent\'s requests do not touch the main cache', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await step($, w, usage(10, 90, 0))
  await step($, w, usage(10_000, 0, 0), 'agent-1')
  const ui = await mount($)

  expect(await ui.find({ type: 'Text', text: /90%/ })).toBeDefined()
  await ui.unmount()
})

test('a request that loses the cached prefix is marked as a miss', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await step($, w, usage(10, 50_000, 0))
  await step($, w, usage(10, 0, 50_000))
  const ui = await mount($)

  expect(await ui.find({ type: 'Text', text: /miss/ })).toBeDefined()
  await ui.unmount()
})

test('another session, or the same one after /clear, does not inherit the cache', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await step($, w, usage(10, 90, 0))

  w.sid = 's2'
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /cache —/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /90%/ })).toBeUndefined()
  await ui.unmount()

  w.sid = 's1'
  const back = await mount($)
  expect(await back.find({ type: 'Text', text: /90%/ })).toBeDefined()
  await back.unmount()
})

test('the shift+tab reminder is cut from the hint', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('clock.every', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'm' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }))
  on('clock.now', () => ({ value: 1 }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hint: '(shift+tab to cycle) · ← 4 agents' } })

  expect(await ui.find({ type: 'Text', text: /shift\+tab|agents/ })).toBeUndefined()
  await ui.unmount()
})
