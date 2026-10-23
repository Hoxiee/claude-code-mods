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

test('after a turn the band shows the cache ratio, its type and the countdown', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.every', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('clock.now', () => ({ value: 60_000 }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, model: 'm' },
  })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hint: '' } })

  expect(await ui.find({ type: 'Text', text: /90%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5m\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5m/ })).toBeDefined()
  await ui.unmount()
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
