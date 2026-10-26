import type { EngineInterface, ModelUsage, Register, SessionRateLimit } from 'claude-code'

type $ = EngineInterface

const TICK_MS = 15_000
const CACHE_TTL_MS = 300_000
// A ping later than this risks landing after the entry lapsed and paying the rebuild itself.
const LAST_SAFE_PING_MS = 285_000
const IDLE_BEFORE_PING_MS = 235_000
const CONFIRM_WINDOW_MS = 120_000
const WINDOW_RECHECK_MS = 600_000
const PING = 'Cache keepalive ping from a plugin. Use no tools and do not think about the task. Reply with exactly: ok'
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

const S = {
  lastReq: 0,
  lastReal: 0,
  inFlight: 0,
  isPinging: false,
  isOff: false,
  ctx: 0,
  window: 0,
  windowAt: 0,
  limits: [] as SessionRateLimit[],
  warned: new Set<string>(),
  pings: 0,
  pingRead: 0,
  pingOut: 0,
  stretchPings: 0,
  rescued: 0,
  rescuedTokens: 0,
  pending: null as null | { text: string; at: number },
}

const nums = (s: unknown, fallback: number[]): number[] => {
  const out = String(s ?? '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(x => Number.isFinite(x) && x > 0)
  return (out.length ? out : fallback).sort((a, b) => a - b)
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const resetIn = (r: SessionRateLimit, now: number) => (r.resetsAt ? span(Date.parse(r.resetsAt) - now) : '?')

const worst = () =>
  S.limits
    .filter(r => r.kind in LIMIT_LABEL)
    .reduce<SessionRateLimit | undefined>((a, r) => (!a || r.percentUsed > a.percentUsed ? r : a), undefined)

async function refreshWindow($: $, now: number) {
  if (S.window && now - S.windowAt < WINDOW_RECHECK_MS) return
  S.windowAt = now
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    S.window = u.context.breakdown?.rawMaxTokens ?? u.context.window
    if (u.context.tokens) S.ctx = u.context.tokens
    if (u.rateLimits.length) S.limits = u.rateLimits
  } catch {
    // No session bound yet; the next measurement retries.
    S.windowAt = 0
  }
}

async function remember($: $, key: string): Promise<boolean> {
  if (S.warned.has(key)) return false
  S.warned.add(key)
  const seen = ((await $.store.get('warned').catch(() => undefined)) as string[] | undefined) ?? []
  if (seen.includes(key)) return false
  await $.store.set('warned', [...seen.slice(-200), key]).catch(() => {})
  return true
}

function onRequest(usage: ModelUsage | null | undefined, now: number) {
  const idle = now - S.lastReal
  if (usage && S.stretchPings > 0 && S.lastReal > 0 && idle > CACHE_TTL_MS && usage.cache_read_input_tokens > usage.cache_creation_input_tokens) {
    S.rescued += 1
    S.rescuedTokens += usage.cache_read_input_tokens
  }
  S.lastReq = now
  S.lastReal = now
  S.stretchPings = 0
}

async function tick($: $, horizonMs: number, minTokens: number) {
  if (S.isOff || S.isPinging || S.inFlight > 0 || S.lastReq === 0) return
  const now = await $.clock.now()
  const idle = now - S.lastReq
  if (idle < IDLE_BEFORE_PING_MS || idle > LAST_SAFE_PING_MS) return
  if (now - S.lastReal > horizonMs || S.ctx < minTokens) return
  if ((worst()?.percentUsed ?? 0) >= 98) return

  S.isPinging = true
  try {
    const r = await $.model.fork({ prompt: PING })
    if (!('usage' in r) || !r.usage) return
    S.pings += 1
    S.stretchPings += 1
    S.pingRead += r.usage.cache_read_input_tokens
    S.pingOut += r.usage.output_tokens
    if (r.usage.cache_read_input_tokens > 0) S.lastReq = await $.clock.now()
    else S.lastReq = 0
  } finally {
    S.isPinging = false
  }
}

function status(now: number, horizonMs: number) {
  const lines: string[] = []
  for (const r of S.limits) {
    lines.push(`${LIMIT_LABEL[r.kind] ?? r.kind}: ${r.percentUsed}% (сброс через ${resetIn(r, now)})`)
  }
  const pct = S.window ? Math.round((S.ctx / S.window) * 100) : 0
  lines.push(`контекст: ${k(S.ctx)} из окна компакта ${S.window ? k(S.window) : '?'} (${pct}%)`)
  const idle = S.lastReq ? now - S.lastReq : 0
  lines.push(
    S.lastReq === 0
      ? 'кэш: запросов ещё не было'
      : `кэш: ${idle < CACHE_TTL_MS ? `тёплый, остынет через ${span(CACHE_TTL_MS - idle)}` : `холодный (${span(idle)} простоя)`}`,
  )
  lines.push(
    `keepalive: ${S.isOff ? 'выключен' : `включён, горизонт ${span(horizonMs)}`}; пингов ${S.pings}` +
      ` (прочитано ${k(S.pingRead)}, вывод ${k(S.pingOut)}); спасено ходов ${S.rescued} (${k(S.rescuedTokens)} не переписано)`,
  )
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const keepalive = options.keepalive !== false
  const horizonMs = Number(options.keepaliveMinutes ?? 30) * 60_000
  const minTokens = Number(options.keepaliveMinTokens ?? 30000)
  const guard = String(options.coldCacheGuard ?? 'confirm')
  const guardMin = Number(options.coldCacheMinTokens ?? 60000)
  const limitSteps = nums(options.limitThresholds, [50, 75, 90, 95])
  const ctxSteps = nums(options.contextThresholds, [70, 85])
  const nudgeAt = options.budgetNudgeAt === 'off' ? Infinity : Number(options.budgetNudgeAt ?? 70)
  S.isOff = !keepalive

  on('session.start', async ($, e, next) => {
    const res = await next(e)
    await $.command.register({
      name: 'budget',
      description: 'Лимиты, контекст, кэш и keepalive; /budget on|off переключает keepalive',
    })
    $.clock.every(TICK_MS, () => void tick($, horizonMs, minTokens).catch(() => {}))
    void refreshWindow($, await $.clock.now())
    return res
  })

  on('session.end', ($, e, next) => {
    S.lastReq = 0
    S.lastReal = 0
    S.window = 0
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || S.isPinging) return yield* next(e)
    S.inFlight += 1
    try {
      const res = yield* next(e)
      onRequest(res.usage, await $.clock.now())
      return res
    } finally {
      S.inFlight -= 1
    }
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.context.tokens !== undefined) S.ctx = e.context.tokens
    if (e.rateLimits.length) S.limits = e.rateLimits

    if (e.changed.includes('rateLimits')) {
      for (const r of e.rateLimits) {
        const label = LIMIT_LABEL[r.kind]
        const step = limitSteps.filter(t => r.percentUsed >= t).pop()
        if (!label || step === undefined || !(await remember($, `${r.kind}:${r.resetsAt}:${step}`))) continue
        const text = `Лимит ${label}: ${r.percentUsed}% (сброс через ${resetIn(r, now)})`
        $.ui.toast(text, { timeoutMs: 8000 })
        if (step >= 90) void $.ui.notify(text, { title: 'budget-guard' }).catch(() => {})
      }
    }

    if (e.changed.includes('context')) {
      await refreshWindow($, now)
      const pct = S.window ? (S.ctx / S.window) * 100 : 0
      if (pct < (ctxSteps[0] ?? 70) - 10) for (const t of ctxSteps) S.warned.delete(`ctx:${t}`)
      const step = ctxSteps.filter(t => pct >= t).pop()
      if (step !== undefined && !S.warned.has(`ctx:${step}`)) {
        S.warned.add(`ctx:${step}`)
        $.ui.toast(
          `Контекст ${k(S.ctx)}/${k(S.window)} (${Math.round(pct)}%): каждый ход перечитывает его целиком. ` +
            'На границе задачи — /compact <что сохранить> или /clear.',
          { timeoutMs: 10_000 },
        )
      }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin?.kind !== 'composer') return next(e)
    const now = await $.clock.now()
    const idle = S.lastReq ? now - S.lastReq : 0
    const isCold = S.lastReq > 0 && idle > CACHE_TTL_MS && S.ctx >= guardMin

    if (isCold && guard !== 'off') {
      const note = `Кэш остыл (${span(idle)} простоя): этот ход заново запишет ~${k(S.ctx)} токенов контекста.`
      const isRepeat = S.pending && S.pending.text === e.text && now - S.pending.at < CONFIRM_WINDOW_MS
      if (guard === 'confirm' && !isRepeat) {
        S.pending = { text: e.text, at: now }
        const text = e.text
        $.clock.after(50, () => void $.prompt.fill({ text, mode: 'replace' }).catch(() => {}))
        return { drop: `${note} Enter — отправить как есть; новая задача — /clear; продолжение — /compact <что сохранить>.` }
      }
      if (guard === 'warn') $.ui.toast(note, { timeoutMs: 8000 })
    }
    S.pending = null

    const w = worst()
    if (w && w.percentUsed >= nudgeAt) {
      const note =
        `[budget-guard] Subscription ${LIMIT_LABEL[w.kind]} window at ${w.percentUsed}% (resets in ${resetIn(w, now)}). ` +
        'Spend frugally: delegate mechanical work to haiku agents, avoid re-reading files, batch tool calls, keep replies short.'
      return next({ ...e, context: [...(e.context ?? []), note] })
    }
    return next(e)
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') S.isOff = arg === 'off'
    const now = await $.clock.now()
    await refreshWindow($, now)
    return { text: status(now, horizonMs) }
  })
}
