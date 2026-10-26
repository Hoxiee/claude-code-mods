import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type TestEngine = Parameters<TestBody>[0]

const FROM_COMPOSER = { wait: false, origin: { kind: 'composer' } } as const

const usage = (read: number, write = 0) => ({
  model: 'claude-opus-5-5',
  input_tokens: 2,
  output_tokens: 10,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

function engine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const forks: string[] = []
  on('command.register', () => ({ value: { command: 'budget' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 150_000 }, rateLimits: [] } }))
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: 'ok', usage: usage(150_000) } }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(150_000, 500) }
  })
  return { clock, forks }
}

async function step($: TestEngine) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of s) void _
}

async function measure($: TestEngine, tokens: number) {
  await $.session.measure({ context: { window: 1_000_000, tokens }, rateLimits: [], changed: ['context'] })
}

test('a ping lands between four and five idle minutes, and stops at the horizon', async ($, on) => {
  const { clock, forks } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 150_000)
  await step($)

  await clock.advance(220_000)
  expect(forks.length).toBe(0)
  await clock.advance(30_000)
  expect(forks.length).toBe(1)

  await clock.advance(60 * 60_000)
  const atHorizon = forks.length
  expect(atHorizon).toBeGreaterThan(5)
  expect(atHorizon).toBeLessThan(9)
  await clock.advance(30 * 60_000)
  expect(forks.length).toBe(atHorizon)
})

test('a small context is not pinged', async ($, on) => {
  const { clock, forks } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 10_000)
  await step($)
  await clock.advance(600_000)
  expect(forks.length).toBe(0)
})

test('the first prompt into a cold large cache is held, the second goes through', async ($, on) => {
  const { clock } = engine(on)
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'budget', args: 'off', origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await measure($, 150_000)
  await step($)
  await clock.advance(400_000)

  const first = await $.prompt.submit({ ...FROM_COMPOSER, text: 'next task' })
  expect(first.drop).toContain('Кэш остыл')
  const second = await $.prompt.submit({ ...FROM_COMPOSER, text: 'next task' })
  expect(second.text).toBe('next task')
})

test('programmatic and meta prompts bypass the cold-cache guard', { options: { keepalive: false } }, async ($, on) => {
  const { clock } = engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 150_000)
  await step($)
  await clock.advance(400_000)

  const programmatic = await $.prompt.submit({
    text: 'plugin task', wait: false, origin: { kind: 'plugin', name: 'another-mod' },
  })
  expect(programmatic.text).toBe('plugin task')
  const meta = await $.prompt.submit({ ...FROM_COMPOSER, text: 'meta task', isMeta: true })
  expect(meta.text).toBe('meta task')
})

test('composer prompts receive the budget note at high subscription usage', { options: { keepalive: false } }, async ($, on) => {
  engine(on)
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: { window: 1_000_000, tokens: 150_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 80 }], changed: ['rateLimits'],
  })

  const result = await $.prompt.submit({ ...FROM_COMPOSER, text: 'next task' })
  expect(result.text).toBe('next task')
  expect(result.context).toHaveLength(1)
  expect(result.context?.[0]).toContain('Subscription 5h window at 80%')
})
