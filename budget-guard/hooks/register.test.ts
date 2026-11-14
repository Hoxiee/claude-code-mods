import { expect, mock, test } from 'claude-code/testing'
import type { ModelForkResult } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type TestEngine = Parameters<TestBody>[0]

const FROM_COMPOSER = { wait: false, origin: { kind: 'composer' } } as const
const KEEPALIVE = { plugin: 'budget-guard', key: 'keepaliveMode' } as const

const usage = (read: number, write = 0) => ({
  model: 'claude-opus-5-5',
  input_tokens: 2,
  output_tokens: 10,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

function engine(on: On, options: {
  tokens?: number
  stepMs?: number
  stepUsage?: ReturnType<typeof usage> | null
  forkMs?: number
  forkResult?: ModelForkResult
} = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const tokens = options.tokens ?? 150_000
  const forks: { prompt: string; at: number }[] = []
  const toasts: string[] = []
  const keepaliveModes: string[] = []
  on('state.set', KEEPALIVE, (_, e, next) => {
    keepaliveModes.push(e.value)
    return next(e)
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'budget' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens }, rateLimits: [] } }))
  on('model.fork', async (_, e) => {
    forks.push({ prompt: e.prompt, at: clock.now() })
    if (options.forkMs) await clock.sleep(options.forkMs)
    return { value: options.forkResult ?? { isAnswered: true, text: 'ok', usage: usage(tokens) } }
  })
  on('turn.step', async function* (_, e) {
    if (options.stepMs) await clock.sleep(options.stepMs)
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: options.stepUsage === undefined ? usage(tokens, 500) : options.stepUsage,
    }
  })
  return { clock, forks, toasts, keepaliveModes }
}

async function step($: TestEngine, agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId })
  for await (const _ of s) void _
}

async function measure($: TestEngine, tokens: number) {
  await $.session.measure({ context: { window: 1_000_000, tokens }, rateLimits: [], changed: ['context'] })
}

async function start($: TestEngine, tokens = 150_000) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, tokens)
}

async function budget($: TestEngine, args = '') {
  const result = await $.command.run({
    command: 'budget', args, origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  return result.text ?? ''
}

test('autoping fires after 4:20 and stops at the idle horizon', async ($, on) => {
  const { clock, forks } = engine(on)
  await start($)
  await step($)

  await clock.advance(259_999)
  expect(forks.length).toBe(0)
  await clock.advance(1)
  expect(forks.length).toBe(1)
  expect(forks[0]?.at).toBe(1_260_000)

  await clock.advance(60 * 60_000)
  const atHorizon = forks.length
  expect(atHorizon).toBeGreaterThan(5)
  expect(atHorizon).toBeLessThan(9)
  expect(await budget($)).toContain('горизонт простоя исчерпан')
  await clock.advance(30 * 60_000)
  expect(forks.length).toBe(atHorizon)
})

test('contexts below 30k are eligible by default', async ($, on) => {
  const { clock, forks } = engine(on, { tokens: 10_000 })
  await start($, 10_000)
  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(1)
})

test('a configured minimum context skips pings with an explanation', { options: { keepaliveMinTokens: '30000' } }, async ($, on) => {
  const { clock, forks } = engine(on, { tokens: 10_000 })
  await start($, 10_000)
  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('контекст 10k ниже порога 30k')
})

test('cache age and ping timing start with the request, not the end of a long response', async ($, on) => {
  const { clock, forks } = engine(on, { stepMs: 60_000 })
  await start($)
  const request = step($)
  await clock.settle()
  await clock.advance(60_000)
  await request
  expect(await budget($)).toContain('остынет через 4:00')

  await clock.advance(199_999)
  expect(forks.length).toBe(0)
  await clock.advance(1)
  expect(forks.length).toBe(1)
  expect(forks[0]?.at).toBe(1_260_000)
})

test('ping duration does not shift the next deadline', async ($, on) => {
  const { clock, forks } = engine(on, { forkMs: 45_000 })
  await start($)
  await step($)
  await clock.advance(305_000)
  expect(forks.length).toBe(1)
  await clock.advance(214_999)
  expect(forks.length).toBe(1)
  await clock.advance(1)
  expect(forks.length).toBe(2)
  expect(forks[1]?.at).toBe(1_520_000)
})

test('an in-flight request is not pinged or rewarmed after expiry', async ($, on) => {
  const { clock, forks } = engine(on, { stepMs: 310_000 })
  await start($)
  const request = step($)
  await clock.settle()
  await clock.advance(270_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('выполняется запрос основной ветки')
  await clock.advance(40_000)
  await request
  await clock.advance(30_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('безопасное окно пинга пропущено')
})

test('a request without usage does not mark the cache warm', async ($, on) => {
  const { clock, forks } = engine(on, { stepUsage: null })
  await start($)
  await step($)
  await clock.advance(270_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('ждёт первый успешный запрос основной ветки')
})

test('subagent requests do not start the main-thread timer', async ($, on) => {
  const { clock, forks } = engine(on)
  await start($)
  await step($, 'worker-1')
  await clock.advance(270_000)
  expect(forks.length).toBe(0)
})

test('a new main request during a ping is not lost or overwritten', async ($, on) => {
  const { clock, forks } = engine(on, { forkMs: 60_000 })
  await start($)
  await step($)
  await clock.advance(280_000)
  expect(forks.length).toBe(1)
  await step($)
  expect(await budget($)).toContain('остынет через 5:00')
  await clock.advance(259_999)
  expect(forks.length).toBe(1)
  await clock.advance(1)
  expect(forks.length).toBe(2)
  expect(forks[1]?.at).toBe(1_540_000)
})

test('an API error is visible and does not cause endless retries', async ($, on) => {
  const { clock, forks } = engine(on, {
    forkResult: { isAnswered: false, reason: 'api-error', status: 404, error: 'invalid_request', usage: usage(0) },
  })
  await start($)
  await step($)
  await clock.advance(270_000)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('api-error: HTTP 404 (invalid_request)')
  expect(await budget($)).toContain('приостановлен до следующего запроса')
  await clock.advance(600_000)
  expect(forks.length).toBe(1)
})

test('nothing-to-fork is not hidden behind an enabled keepalive status', async ($, on) => {
  const { clock, forks } = engine(on, { forkResult: { isAnswered: false, reason: 'nothing-to-fork' } })
  await start($)
  await step($)
  await clock.advance(280_000)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('nothing-to-fork')
})

test('a cache miss pauses pings but preserves the cold-cache guard', async ($, on) => {
  const { clock, forks } = engine(on, { forkResult: { isAnswered: true, text: 'ok', usage: usage(0, 150_000) } })
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($)
  await step($)
  await clock.advance(310_000)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('префикс не попал в кэш')
  const result = await $.prompt.submit({ ...FROM_COMPOSER, text: 'next task' })
  expect(result.drop).toContain('Кэш остыл')
})

test('a small partial hit does not count as warming the whole prefix', async ($, on) => {
  const { clock, forks } = engine(on, { forkResult: { isAnswered: true, text: 'ok', usage: usage(1000, 149_000) } })
  await start($)
  await step($)
  await clock.advance(600_000)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('префикс не попал в кэш')
})

test('a successful main request resumes pings after an error', async ($, on) => {
  const options = { forkResult: { isAnswered: false, reason: 'nothing-to-fork' } as ModelForkResult }
  const { clock, forks } = engine(on, options)
  await start($)
  await step($)
  await clock.advance(270_000)
  options.forkResult = { isAnswered: true, text: 'ok', usage: usage(150_000) }
  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(2)
  expect(await budget($)).not.toContain('nothing-to-fork')
})

test('disabled keepalive sends no requests and is visible in status', { options: { keepalive: false } }, async ($, on) => {
  const { clock, forks } = engine(on)
  await start($)
  await step($)
  await clock.advance(280_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('keepalive: выключен')
})

test('the off command saves the session override and stays off after real requests', async ($, on) => {
  const { clock, forks, keepaliveModes } = engine(on)
  await start($)
  await step($)
  await clock.advance(250_000)
  expect(await budget($, 'off')).toContain('keepalive: выключен')
  expect(keepaliveModes).toEqual(['off'])

  await clock.advance(600_000)
  expect(forks.length).toBe(0)
  await step($)
  await clock.advance(270_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('/budget on — включить')
})

test('the on command resumes pings even when the configured default is off', { options: { keepalive: false } }, async ($, on) => {
  const { clock, forks, keepaliveModes } = engine(on)
  await start($)
  await step($)
  await clock.advance(200_000)
  expect(forks.length).toBe(0)
  expect(await budget($, 'on')).toContain('keepalive: включён')
  expect(keepaliveModes).toEqual(['on'])
  await budget($, 'on')

  await clock.advance(59_999)
  expect(forks.length).toBe(0)
  await clock.advance(1)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('/budget off — выключить')
})

test('a saved off override survives mod startup with keepalive enabled by default', async ($, on) => {
  const { clock, forks } = engine(on)
  on('state.get', KEEPALIVE, () => ({ value: { value: 'off', version: 1 } }))
  await start($)
  await step($)
  await clock.advance(270_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('keepalive: выключен')
})

test('a saved on override survives mod startup with keepalive disabled by default', { options: { keepalive: false } }, async ($, on) => {
  const { clock, forks } = engine(on)
  on('state.get', KEEPALIVE, () => ({ value: { value: 'on', version: 1 } }))
  await start($)
  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('keepalive: включён')
})

test('enabling after cache expiry waits for a real request instead of warming a cold prefix', async ($, on) => {
  const { clock, forks } = engine(on)
  await start($)
  await step($)
  await budget($, 'off')
  await clock.advance(400_000)
  await budget($, 'on')
  await clock.advance(60_000)
  expect(forks.length).toBe(0)
  expect(await budget($)).toContain('безопасное окно пинга пропущено')

  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(1)
})

test('turning keepalive off stops pending retries', async ($, on) => {
  const { clock, forks, toasts } = engine(on, { forkResult: transientError() })
  await start($)
  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(1)
  await budget($, 'off')
  await clock.advance(600_000)
  expect(forks.length).toBe(1)
  expect(toasts).toHaveLength(0)
})

test('turning keepalive off lets an in-flight ping finish without starting more', async ($, on) => {
  const { clock, forks } = engine(on, { forkMs: 60_000 })
  await start($)
  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(1)
  expect(await budget($, 'off')).toContain('уже начатый пинг ещё выполняется')
  await clock.advance(600_000)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('keepalive: выключен')
  expect(await budget($)).not.toContain('уже начатый пинг ещё выполняется')
})

test('turning keepalive off leaves subscription warnings active', async ($, on) => {
  const { toasts } = engine(on)
  await start($)
  await budget($, 'off')
  await $.session.measure({
    context: { window: 1_000_000, tokens: 150_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 75 }], changed: ['rateLimits'],
  })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Лимит 5h: 75%')
})

test('the first prompt into a cold large cache is held, the second goes through', async ($, on) => {
  const { clock } = engine(on)
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($)
  await budget($, 'off')
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
  await start($)
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

const transientError = (): ModelForkResult => ({
  isAnswered: false, reason: 'api-error', status: 503, error: 'server_error',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

test('a transient failure is retried within the safe window', async ($, on) => {
  const options = { forkResult: transientError() }
  const { clock, forks, toasts } = engine(on, options)
  await start($)
  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(1)
  expect(await budget($)).toContain('повторная попытка через')
  options.forkResult = { isAnswered: true, text: 'ok', usage: usage(150_000) }
  await clock.advance(10_000)
  expect(forks.length).toBe(2)
  expect(await budget($)).toContain('остынет через 5:00')
  expect(await budget($)).not.toContain('api-error')
  expect(toasts).toHaveLength(0)
})

test('retries are bounded and a permanent failure is announced once', async ($, on) => {
  const { clock, forks, toasts } = engine(on, { forkResult: transientError() })
  await start($)
  await step($)
  await clock.advance(600_000)
  expect(forks.map(f => f.at)).toEqual([1_260_000, 1_270_000, 1_280_000])
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Автопрогрев приостановлен')
  expect(await budget($)).toContain('приостановлен до следующего запроса')
})

test('a slow failure is not retried after the safe window', async ($, on) => {
  const { clock, forks } = engine(on, { forkMs: 30_000, forkResult: transientError() })
  await start($)
  await step($)
  await clock.advance(600_000)
  expect(forks.length).toBe(1)
})

test('an API error that already spent tokens is not retried', async ($, on) => {
  const result = transientError()
  if ('usage' in result) result.usage.cache_creation_input_tokens = 150_000
  const { clock, forks } = engine(on, { forkResult: result })
  await start($)
  await step($)
  await clock.advance(600_000)
  expect(forks.length).toBe(1)
})

test('a /clear (session.end without session.start) does not leave autoping dead', async ($, on) => {
  const { clock, forks } = engine(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await start($)
  await step($)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)

  await step($)
  await clock.advance(260_000)
  expect(forks.length).toBe(1)
})

test('keepalive status is published for the statusline', async ($, on) => {
  const statuses: string[] = []
  on('state.set', { plugin: 'budget-guard', key: 'keepaliveStatus' }, (_, e, next) => {
    statuses.push(e.value)
    return next(e)
  })
  const { clock } = engine(on)
  await start($)
  expect(statuses.at(-1)).toBe('idle')
  await step($)
  await clock.settle()
  expect(statuses.at(-1)).toBe('armed')
  await budget($, 'off')
  expect(statuses.at(-1)).toBe('off')
  await budget($, 'on')
  expect(statuses.at(-1)).toBe('armed')
})
