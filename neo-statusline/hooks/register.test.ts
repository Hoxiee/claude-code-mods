import { expect, mock, test } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'
import type { ModelForkResult } from 'claude-code'

const WITH_FORK = {
  plugins: [{
    name: 'test-keepalive',
    register(on) {
      on('command.run', { command: 'test-ping' }, async $ => {
        await $.model.fork({ prompt: 'ok' })
        return {}
      })
    },
  } satisfies Plugin],
}

type On = Parameters<TestBody>[1]
type TestEngine = Parameters<TestBody>[0]
type Reading = { at: number; warmedAt?: number; ratio: number; read: number; write: number; fresh: number }
type Saved = { cache: Reading; ttl: '5m' | '1h' | null; total: { read: number }; agents: Record<string, { cache: Reading }> }

const usage = (read = 150_000, write = 0) => ({
  model: 'claude-opus-5-5', input_tokens: 2, output_tokens: 10,
  cache_read_input_tokens: read, cache_creation_input_tokens: write,
})

function engine(on: On, options: { stepMs?: number; forkMs?: number; forkResult?: ModelForkResult } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const values = new Map<string, unknown>()
  const state = { sid: 'session-1' }
  on('store.get', (_, e) => ({ value: values.get(e.key) }))
  on('store.set', (_, e) => {
    values.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: state.sid }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: {
    startedAt: 1_000_000, context: { window: 1_000_000, tokens: 150_000 }, rateLimits: [],
  } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: {
    exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
  } }))
  on('model.fork', async () => {
    if (options.forkMs) await clock.sleep(options.forkMs)
    return { value: options.forkResult ?? { isAnswered: true, text: 'ok', usage: usage() } }
  })
  on('turn.step', async function* (_, e) {
    if (options.stepMs) await clock.sleep(options.stepMs)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage() }
  })
  const saved = () => (values.get('cache-v2') as Record<string, Saved>)[state.sid]!
  return { clock, state, saved }
}

async function start($: TestEngine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function fork($: TestEngine) {
  return $.command.run({
    command: 'test-ping', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

async function step($: TestEngine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId })
  for await (const _ of stream) void _
}

test('main cache age starts when the request starts', WITH_FORK, async ($, on) => {
  const { clock, saved } = engine(on, { stepMs: 60_000 })
  await start($)
  const request = step($)
  await clock.settle()
  await clock.advance(60_000)
  await request
  expect(saved().cache.at).toBe(1_000_000)
})

test('subagent cache age also starts when the request starts', WITH_FORK, async ($, on) => {
  const { clock, saved } = engine(on, { stepMs: 60_000 })
  await start($)
  const request = step($, 'worker-1')
  await clock.settle()
  await clock.advance(60_000)
  await request
  expect(saved().agents['worker-1']?.cache.at).toBe(1_000_000)
  expect(saved().cache).toBeNull()
})

test('a confirmed fork refreshes main cache expiry and cumulative reads', WITH_FORK, async ($, on) => {
  const { clock, saved } = engine(on, { forkMs: 45_000 })
  await start($)
  await step($)
  await clock.advance(260_000)
  const ping = fork($)
  await clock.settle()
  await clock.advance(45_000)
  await ping
  expect(saved().cache.at).toBe(1_000_000)
  expect(saved().cache.warmedAt).toBe(1_260_000)
  expect(saved().total.read).toBe(300_000)
})

test('background pings do not turn a five-minute TTL into an hour', WITH_FORK, async ($, on) => {
  const { clock, saved } = engine(on)
  await start($)
  await step($)
  await clock.advance(260_000)
  await fork($)
  await clock.advance(100_000)
  await step($)
  expect(saved().ttl).toBeNull()
  expect(saved().cache.at).toBe(1_360_000)
  expect(saved().cache.warmedAt).toBeUndefined()
})

test('cache misses and small partial hits do not extend the countdown', WITH_FORK, async ($, on) => {
  const options = { forkResult: { isAnswered: true, text: 'ok', usage: usage(0, 150_000) } as ModelForkResult }
  const { clock, saved } = engine(on, options)
  await start($)
  await step($)
  await clock.advance(260_000)
  await fork($)
  expect(saved().cache.warmedAt).toBeUndefined()
  options.forkResult = { isAnswered: true, text: 'ok', usage: usage(1000, 149_000) }
  await fork($)
  expect(saved().cache.warmedAt).toBeUndefined()
})

test('errors and nothing-to-fork do not warm the statusline', WITH_FORK, async ($, on) => {
  const options = { forkResult: { isAnswered: false, reason: 'nothing-to-fork' } as ModelForkResult }
  const { clock, saved } = engine(on, options)
  await start($)
  await step($)
  await clock.advance(260_000)
  await fork($)
  options.forkResult = { isAnswered: false, reason: 'api-error', status: 503, error: 'server_error', usage: usage(0) }
  await fork($)
  expect(saved().cache.warmedAt).toBeUndefined()
})

test('a cache read refreshes expiry even without a text reply', WITH_FORK, async ($, on) => {
  const { clock, saved } = engine(on, { forkResult: { isAnswered: false, reason: 'empty-reply', usage: usage() } })
  await start($)
  await step($)
  await clock.advance(260_000)
  await fork($)
  expect(saved().cache.warmedAt).toBe(1_260_000)
})

test('a late fork does not overwrite a newer main request', WITH_FORK, async ($, on) => {
  const { clock, saved } = engine(on, { forkMs: 60_000 })
  await start($)
  await step($)
  await clock.advance(260_000)
  const ping = fork($)
  await clock.settle()
  await clock.advance(20_000)
  await step($)
  await clock.advance(40_000)
  await ping
  expect(saved().cache.at).toBe(1_280_000)
  expect(saved().cache.warmedAt).toBeUndefined()
})

test('a fork from the previous session does not warm the session after clear', WITH_FORK, async ($, on) => {
  const { clock, state, saved } = engine(on, { forkMs: 60_000 })
  await start($)
  await step($)
  await clock.advance(260_000)
  const ping = fork($)
  await clock.settle()
  await clock.advance(20_000)
  state.sid = 'session-2'
  await step($)
  await clock.advance(40_000)
  await ping
  expect(saved().cache.at).toBe(1_280_000)
  expect(saved().cache.warmedAt).toBeUndefined()
  expect(saved().total.read).toBe(150_000)
})

test('the visible countdown follows a confirmed fork and still expires', WITH_FORK, async ($, on) => {
  const { clock } = engine(on, { forkMs: 45_000 })
  await start($)
  await step($)
  await clock.advance(260_000)
  const ping = fork($)
  await clock.settle()
  await clock.advance(45_000)
  await ping

  const ui = await $.ui.mount({
    plugin: 'neo-statusline', component: 'PromptHint', surface: 'terminal',
    props: { isDraft: false, isWorking: false, hint: '' },
  })
  expect(await ui.find({ type: 'Text', text: /↻/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cold/ })).toBeUndefined()
  // Allow the next 15-second statusline refresh to render the expiry.
  await clock.advance(270_001)
  expect(await ui.find({ type: 'Text', text: /cold/ })).toBeDefined()
  await ui.unmount()
})

