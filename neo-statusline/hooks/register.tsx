import type { AgentInfo, Hook, Register, SessionUsage } from 'claude-code'

type Api = Parameters<Hook<'session.start'>>[0]

type ContextReading = { percent: number; tokens?: number; window: number; estimated: boolean }
const CONTEXT_TTL_MS = 30_000
let contextRevision = 0
let contextCache: {
  key: string
  expires: number
  pending: Promise<ContextReading | undefined>
} | undefined

async function contextReading($: Api, usage: SessionUsage) {
  const now = await $.clock.now()
  const key = `${await $.session.id().catch(() => '')}:${await $.session.model()}:${contextRevision}`
  if (contextCache?.key === key && now < contextCache.expires) return contextCache.pending

  const pending = (async (): Promise<ContextReading | undefined> => {
    try {
      const estimate = (await $.session.usage({ breakdown: 'full' })).context.breakdown
      if (estimate && Number.isFinite(estimate.totalTokens) && estimate.rawMaxTokens > 0) {
        return {
          percent: estimate.totalTokens / estimate.rawMaxTokens * 100,
          tokens: estimate.totalTokens,
          window: estimate.rawMaxTokens,
          estimated: true,
        }
      }
    } catch {}
    const context = usage.context
    if (context.percent !== undefined && Number.isFinite(context.percent)) {
      return { percent: context.percent, tokens: context.tokens, window: context.window, estimated: false }
    }
    if (context.tokens !== undefined && Number.isFinite(context.tokens) && context.window > 0) {
      return { percent: context.tokens / context.window * 100, tokens: context.tokens, window: context.window, estimated: false }
    }
    return undefined
  })()
  const entry = { key, expires: now + CONTEXT_TTL_MS, pending }
  contextCache = entry
  return pending
}

type Git = {
  branch: string
  ahead: number
  behind: number
  modified: number
  added: number
  deleted: number
  renamed: number
  untracked: number
  conflicts: number
}

type Ttl = '5m' | '1h'
// One main-thread request: `fresh` is the uncached part of the prompt; `broke` marks a
// request that lost most of what the previous one had cached.
type Cache = { ratio: number; read: number; write: number; fresh: number; at: number; broke: boolean }
type Total = { read: number; write: number; fresh: number }
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
// What one subagent has done so far: its own model, cache and token sums. `context` is the
// input side of its last request, the size of its window right now.
type Agent = { model: string; effort: string; cache: Cache | null; total: Total; out: number; requests: number; context: number; since: number }
type Saved = { cache: Cache | null; total: Total; ttl: Ttl | null; agents?: Record<string, Agent> }

const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const TICK_MS = 15_000
const STORE_KEY = 'cache-v2'
const KEEP_SESSIONS = 12
const KEEP_AGENTS = 40
const EFFORT_KEY = 'effort-v1'

const C = {
  ink: '#1e1e2e',
  label: '#a6adc8',
  empty: '#585b70',
  sep: '#585b70',
  blue: '#89b4fa',
  sky: '#89dceb',
  teal: '#94e2d5',
  mauve: '#cba6f7',
  pink: '#f5c2e7',
  green: '#a6e3a1',
  lime: '#b8f0a0',
  yellow: '#f9e2af',
  orange: '#fab387',
  red: '#f38ba8',
}

const usageColor = (pct: number) =>
  pct >= 80 ? C.red : pct >= 65 ? C.orange : pct >= 50 ? C.yellow : C.green

const cacheColor = (ratio: number) =>
  ratio >= 90 ? C.lime : ratio >= 75 ? C.green : ratio >= 50 ? C.yellow : ratio > 0 ? C.orange : C.red

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)

  return d >= 1
    ? `${d}d${h % 24 ? `${h % 24}h` : ''}`
    : h >= 1
      ? `${h}h${m % 60 ? `${m % 60}m` : ''}`
      : `${m}m`
}

const countdown = (ms: number) =>
  ms < 60_000 ? `${Math.max(0, Math.ceil(ms / 1000))}s` : span(ms)

const clock = (ms: number) => {
  const d = new Date(ms)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const bar = (pct: number, width: number) => {
  const filled = Math.min(width, Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * width)))

  return { on: '█'.repeat(filled), off: '░'.repeat(width - filled) }
}

const middle = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, Math.ceil((max - 1) / 2))}…${s.slice(s.length - Math.floor((max - 1) / 2))}`

const prettyModel = (id: string) => {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id)

  if (m) {
    const name = m[1]!
    return `${name[0]!.toUpperCase()}${name.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  }

  return id.replace(/\[.*\]$/, '')
}

const EFFORT: Record<string, string> = { low: 'lo', medium: 'md', high: 'hi', xhigh: 'xhi', max: 'max' }

const effortOf = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : String(v))

// One request's cache numbers, set against the one before it.
function measure(u: Usage, prev: Cache | null, now: number): Cache {
  const fresh = u.input_tokens
  const read = u.cache_read_input_tokens
  const write = u.cache_creation_input_tokens
  const total = fresh + write + read

  return {
    ratio: total > 0 ? Math.round((read / total) * 100) : 0,
    read,
    write,
    fresh,
    at: now,
    broke: prev !== null && prev.read > 5000 && read < prev.read * 0.5,
  }
}

const sumOf = (t: Total, u: Usage): Total => ({
  read: t.read + u.cache_read_input_tokens,
  write: t.write + u.cache_creation_input_tokens,
  fresh: t.fresh + u.input_tokens,
})

const AGENT_STATE: Record<string, [string, string]> = {
  pending: ['◌', C.label],
  running: ['◉', C.orange],
  waiting: ['◌', C.yellow],
  idle: ['●', C.green],
  completed: ['✓', C.green],
  failed: ['✗', C.red],
  killed: ['✗', C.red],
}

const parseGit = (out: string): Git => {
  const g: Git = { branch: '', ahead: 0, behind: 0, modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicts: 0 }
  let oid = ''

  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) g.branch = line.slice(14)
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13, 20)
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      g.ahead = Number(m?.[1] ?? 0)
      g.behind = Number(m?.[2] ?? 0)
    } else if (line.startsWith('? ')) g.untracked += 1
    else if (line.startsWith('u ')) g.conflicts += 1
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      if (line[0] === '2') g.renamed += 1
      else if (xy.includes('A')) g.added += 1
      if (xy.includes('D')) g.deleted += 1
      if (/[MT]/.test(xy)) g.modified += 1
    }
  }

  if (g.branch === '(detached)') g.branch = oid
  return g
}

const S: {
  git: Git | null
  cwd: string
  model: string
  effort: string
  // The session the cache numbers belong to: the store is shared by every session, and a
  // /clear changes the id without a `session.start`.
  sid: string | null
  // The last main-thread request, and the sums over the whole session.
  cache: Cache | null
  total: Total
  // The TTL the cache is known to have; null while `auto` has not seen proof.
  ttl: Ttl | null
  // Subagents of this session by id, and the agent whose transcript is on screen
  // (undefined: the main conversation).
  agents: Record<string, Agent>
  view: string | undefined
  isBusy: boolean
} = { git: null, cwd: '', model: '', effort: '', sid: null, cache: null, total: { read: 0, write: 0, fresh: 0 }, ttl: null, agents: {}, view: undefined, isBusy: false }

const sessionId = ($: Api) => $.session.id().catch(() => '')

// Points the cache numbers at the current session, loading what the store kept for it.
async function bind($: Api) {
  const sid = await sessionId($)
  if (sid === S.sid) return

  const all = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, Saved>
  const saved = all[sid]

  S.sid = sid
  S.cache = saved?.cache ?? null
  S.total = saved?.total ?? { read: 0, write: 0, fresh: 0 }
  S.ttl = saved?.ttl === '5m' || saved?.ttl === '1h' ? saved.ttl : null
  S.agents = saved?.agents ?? {}
}

async function save($: Api) {
  if (S.sid === null) return

  const all = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, Saved>
  const agents = Object.entries(S.agents)
    .sort(([, a], [, b]) => (b.cache?.at ?? 0) - (a.cache?.at ?? 0))
    .slice(0, KEEP_AGENTS)
  all[S.sid] = { cache: S.cache, total: S.total, ttl: S.ttl, agents: Object.fromEntries(agents) }

  // Drop the least recently used sessions so the store does not grow for ever.
  const stale = Object.keys(all)
    .sort((a, b) => (all[b]!.cache?.at ?? 0) - (all[a]!.cache?.at ?? 0))
    .slice(KEEP_SESSIONS)
  for (const k of stale) delete all[k]

  await $.store.set(STORE_KEY, all)
}

async function load($: Api) {
  await bind($)

  const effort = await $.store.get(EFFORT_KEY)
  if (typeof effort === 'string') S.effort = effort
}

// One main-thread request landed: its own numbers are the cache's state now.
async function record($: Api, u: Usage, forced: Ttl | null) {
  await bind($)

  const now = await $.clock.now()
  const prev = S.cache
  const next = measure(u, prev, now)
  const total = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
  const gap = prev ? now - prev.at : 0

  // After a pause past 5m a warm read proves the 1h cache; a cold miss on
  // a big prompt (inside the hour) proves 5m.
  if (forced === null && prev && gap > TTL_MS['5m'] + 30_000 && total > 4000) {
    if (next.ratio >= 50) S.ttl = '1h'
    else if (next.ratio <= 10 && gap < TTL_MS['1h']) S.ttl = '5m'
  }

  S.cache = next
  S.total = sumOf(S.total, u)
  await save($)
}

// One subagent request landed. A subagent has a cache of its own, so it never feeds the
// main thread's numbers or the TTL guess.
async function recordAgent($: Api, id: string, model: string, effort: string, u: Usage) {
  await bind($)

  const now = await $.clock.now()
  const prev = S.agents[id]
  const cache = measure(u, prev?.cache ?? null, now)

  S.agents[id] = {
    model: model || prev?.model || '',
    effort: effort || prev?.effort || '',
    cache,
    total: sumOf(prev?.total ?? { read: 0, write: 0, fresh: 0 }, u),
    out: (prev?.out ?? 0) + u.output_tokens,
    requests: (prev?.requests ?? 0) + 1,
    context: cache.fresh + cache.write + cache.read,
    since: prev?.since ?? now,
  }
  await save($)
  $.ui.invalidate('ui.render')
}

async function refresh($: Api) {
  if (S.isBusy) return
  S.isBusy = true

  try {
    S.cwd = await $.session.cwd()
    S.model = await $.session.model()

    const run = await $.process.run(
      ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      { cwd: S.cwd, timeoutMs: 4000 },
    )
    S.git = run.exitCode === 0 ? parseGit(run.stdout) : null
  } catch {
    S.git = null
  } finally {
    S.isBusy = false
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = (on, options) => {
  const forced = options.cacheTtl === '5m' || options.cacheTtl === '1h' ? options.cacheTtl : null
  const showLimits = options.showLimits !== false

  on('session.start', async ($, e, next) => {
    await load($)
    $.clock.every(TICK_MS, () => void refresh($))
    void refresh($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const effort = effortOf(e.effort)

    if (e.agentId === undefined) {
      S.model = e.model

      if (effort !== S.effort) {
        S.effort = effort
        await $.store.set(EFFORT_KEY, effort)
      }
    }

    // A step's `usage` is that one request's; the cache's state is the last one's.
    const res = yield* next(e)

    if (res.usage) {
      if (e.agentId === undefined) await record($, res.usage, forced)
      else await recordAgent($, e.agentId, res.usage.model || e.model, effort, res.usage)
    }

    return res
  })

  on('turn.complete', async ($, e, next) => {
    contextRevision++
    void refresh($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (e.tool === 'Bash' || e.tool === 'Edit' || e.tool === 'Write') void refresh($)

    return ran
  })

  // Which transcript is on screen. The band above the prompt is told the view whenever it
  // changes (`PromptHint` is not), so it is the source; `ui.view` makes the switch show
  // at once when the mod itself, or another one, asked for it.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const id = e.props.view?.agentId

    if (id !== S.view) {
      S.view = id
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('ui.view', async ($, e, next) => {
    const res = await next(e)

    if (!res.deny) {
      S.view = e.agentId
      $.ui.invalidate('ui.render')
    }

    return res
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    // A /clear or a resume moves the process to another session without a `session.start`.
    await bind($).catch(() => {})
    // A failing read must not take the whole bar down with it.
    const usage = await $.session.usage().catch((): SessionUsage => ({
      startedAt: now,
      context: { window: 0 },
      rateLimits: [],
    }))
    const agents = await $.agent.list().catch((): AgentInfo[] => [])
    const cols = e.viewport?.columns ?? 120
    // 0: bare essentials, 1: + details, 2: + everything.
    const level = cols >= 150 ? 2 : cols >= 115 ? 1 : 0
    const { git, cache, effort } = S
    const sep = <Text color={C.sep}> │ </Text>
    const items: unknown[] = []
    const ttl: Ttl | null = forced ?? S.ttl
    const view = S.view
    const agent = view === undefined ? undefined : agents.find(a => a.id === view)
    const stat = view === undefined ? undefined : S.agents[view]

    // `◆ Model:effort`.
    const modelItem = (model: string, level_: string) => (
      <Text>
        <Text color={C.mauve} bold>
          ◆ {prettyModel(model || 'claude')}
        </Text>
        {level_ ? (
          <Text color={C.pink} bold>
            :{EFFORT[level_] ?? level_}
          </Text>
        ) : null}
      </Text>
    )

    // Prompt cache: the last request's hit ratio (Σ: the whole run's), its lifetime, and when
    // it goes cold. `+Nk` is what the last request wrote, `miss` a lost prefix.
    const cacheItem = (c: Cache | null, t: Total) => {
      if (!c) return <Text color={C.label}>cache — {ttl ?? '5m?'}</Text>

      const sum = t.read + t.write + t.fresh
      const sumRatio = sum > 0 ? Math.round((t.read / sum) * 100) : 0
      const left = TTL_MS[ttl ?? '5m'] - (now - c.at)
      const frac = left / TTL_MS[ttl ?? '5m']
      const timeColor = left <= 0 ? C.red : frac < 0.2 ? C.orange : frac < 0.5 ? C.yellow : C.sky

      return (
        <Text>
          <Text color={C.label}>cache </Text>
          <Text color={cacheColor(c.ratio)} bold>
            {c.ratio}%
          </Text>
          {level >= 1 ? <Text color={C.label}> Σ{sumRatio}%</Text> : null}
          {c.broke ? (
            <Text color={C.red} bold>
              {' '}miss
            </Text>
          ) : null}
          {level >= 1 && c.write >= 4000 ? <Text color={C.orange}> +{tokens(c.write)}</Text> : null}
          <Text color={C.label}> {ttl ?? '5m?'}</Text>
          {left > 0 ? (
            <Text color={timeColor} bold>
              {' '}{countdown(left)}
              {level >= 1 ? <Text color={C.label} bold={false}> → {clock(c.at + TTL_MS[ttl ?? '5m'])}</Text> : null}
            </Text>
          ) : (
            <Text color={C.red} bold>
              {' '}cold
            </Text>
          )}
        </Text>
      )
    }

    if (view !== undefined) {
      // A subagent's transcript is on screen: its own model, window, cache and tokens.
      const [dot, dotColor] = AGENT_STATE[agent?.status ?? 'running'] ?? AGENT_STATE.running!
      const name = agent?.description || agent?.name || view.slice(0, 8)

      items.push(
        <Text>
          <Text color={dotColor} bold>
            {dot}{' '}
          </Text>
          <Text color={C.sky} bold>
            ⤷ {agent?.type ?? 'agent'}
          </Text>
          <Text color={C.label}> {middle(name, level === 0 ? 18 : 32)}</Text>
        </Text>,
      )

      if (!stat) {
        items.push(<Text color={C.label}>no requests seen yet</Text>)
      } else {
        items.push(modelItem(stat.model, stat.effort))

        // Its window is known only when it runs on the model the session reports a window for.
        const sameModel = prettyModel(stat.model) === prettyModel(S.model)
        const pct = sameModel && usage.context.window > 0 ? (stat.context / usage.context.window) * 100 : undefined

        items.push(
          <Text>
            <Text color={C.label}>ctx </Text>
            {pct !== undefined ? (
              <Text>
                <Text color={usageColor(pct)}>{bar(pct, level === 0 ? 6 : 8).on}</Text>
                <Text color={C.empty}>{bar(pct, level === 0 ? 6 : 8).off}</Text>
                <Text color={usageColor(pct)} bold>
                  {' '}{Math.round(pct)}%
                </Text>
                {level >= 1 ? <Text color={C.label}> {tokens(stat.context)}/{tokens(usage.context.window)}</Text> : null}
              </Text>
            ) : (
              <Text color={C.blue} bold>
                {tokens(stat.context)}
              </Text>
            )}
          </Text>,
        )

        items.push(cacheItem(stat.cache, stat.total))

        // Everything the agent has been billed for, by kind.
        items.push(
          <Text>
            <Text color={C.label}>tok </Text>
            <Text color={C.blue}>↑{tokens(stat.out)}</Text>
            <Text color={C.label}> in </Text>
            <Text color={C.blue}>{tokens(stat.total.fresh)}</Text>
            {level >= 1 ? (
              <Text>
                <Text color={C.label}> cw </Text>
                <Text color={C.orange}>{tokens(stat.total.write)}</Text>
                <Text color={C.label}> cr </Text>
                <Text color={C.lime}>{tokens(stat.total.read)}</Text>
              </Text>
            ) : null}
          </Text>,
        )

        if (level >= 1) items.push(<Text color={C.label}>{stat.requests} req</Text>)
        if (level >= 2) items.push(<Text color={C.label}>up {span(now - stat.since)}</Text>)
      }

      // The ledger is the session's: it has no per-agent split.
      if (level >= 1 && usage.cost) {
        items.push(
          <Text>
            <Text color={C.label}>session </Text>
            <Text color={C.yellow} bold>
              ${usage.cost.usd.toFixed(2)}
            </Text>
          </Text>,
        )
      }
    } else {
      // Model, effort.
      items.push(
        <Text>
          <Text color={e.props.isWorking ? C.orange : C.green} bold>
            {e.props.isWorking ? '◉' : '●'}{' '}
          </Text>
          {modelItem(S.model || (await $.session.model().catch(() => '')), effort)}
        </Text>,
      )

      // Branch and what changed in it.
      if (git) {
        const parts: [string, number, string][] = [
          ['~', git.modified, C.yellow],
          ['+', git.added, C.green],
          ['-', git.deleted, C.red],
          ['→', git.renamed, C.sky],
          ['?', git.untracked, C.label],
        ]
        const changed = parts.filter(([, n]) => n > 0)

        items.push(
          <Text>
            <Text color={C.teal} bold>
              ◇ {middle(git.branch, level === 0 ? 16 : 24)}
            </Text>
            {changed.length === 0 && git.conflicts === 0 ? <Text color={C.green}> ✓</Text> : null}
            {changed.map(([k, n, color]) => (
              <Text color={color}> {k}{n}</Text>
            ))}
            {git.conflicts > 0 ? (
              <Text color={C.red} bold>
                {' '}!{git.conflicts}
              </Text>
            ) : null}
            {git.ahead > 0 ? <Text color={C.yellow}> ↑{git.ahead}</Text> : null}
            {git.behind > 0 ? <Text color={C.red}> ↓{git.behind}</Text> : null}
          </Text>,
        )
      }

      // Context window.
      const context = await contextReading($, usage)
      const pct = context?.percent

      if (context && pct !== undefined) {
        const used = context.tokens ?? 0
        const color = used > 250_000 && pct < 65 ? C.yellow : usageColor(pct)
        const b = bar(pct, level === 0 ? 6 : 8)

        items.push(
          <Text>
            <Text color={C.label}>ctx </Text>
            <Text color={color}>{b.on}</Text>
            <Text color={C.empty}>{b.off}</Text>
            <Text color={color} bold>
              {' '}{context.estimated ? '~' : ''}{Math.round(pct)}%
            </Text>
            {level >= 1 ? (
              <Text color={C.label}>
                {' '}{tokens(used)}/{tokens(context.window)}
              </Text>
            ) : null}
            {pct >= 80 ? <Text color={C.red} bold> !</Text> : null}
          </Text>,
        )
      }

      if (!context) items.push(<Text color={C.label}>ctx —</Text>)

      items.push(cacheItem(cache, S.total))

      // Subagents: running over all the session has started. The engine's own "N agents"
      // reminder is cut from the hint below, so this carries it.
      if (agents.length > 0) {
        const running = agents.filter(a => a.status === 'running' || a.status === 'pending').length

        items.push(
          <Text>
            <Text color={C.label}>agents </Text>
            <Text color={running > 0 ? C.orange : C.green} bold>
              {running}
            </Text>
            <Text color={C.label}>/{agents.length}</Text>
          </Text>,
        )
      }
    }

    // Rate limits.
    for (const r of usage.rateLimits) {
      if (!showLimits && (r.kind === 'five_hour' || r.kind === 'seven_day')) continue

      const label = r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : r.kind === 'spend_limit' ? 'spend' : r.kind
      const reset = r.resetsAt ? Date.parse(r.resetsAt) - now : NaN

      items.push(
        <Text>
          <Text color={C.label}>{label} </Text>
          <Text color={usageColor(r.percentUsed)} bold>
            {Math.round(r.percentUsed)}%
          </Text>
          {level >= 1 && Number.isFinite(reset) && reset > 0 ? <Text color={C.label}> ({span(reset)})</Text> : null}
        </Text>,
      )
    }

    // Cost, session length.
    if (view === undefined) {
      if (usage.cost) {
        items.push(
          <Text color={C.yellow} bold>
            ${usage.cost.usd.toFixed(2)}
          </Text>,
        )
      }

      if (level >= 2) items.push(<Text color={C.label}>up {span(now - usage.startedAt)}</Text>)
    }

    // The engine's hint minus the "(shift+tab to cycle)" and "N agents" reminders, and the
    // separators it leaves behind.
    const hint = e.props.hint
      .replace(/\(shift\+tab to cycle\)/gi, '')
      .replace(/[←→]?\s*\d+\s+agents?/gi, '')
      .replace(/^[\s·•]+|[\s·•]+$/g, '')

    // One row of status; the engine's own hint (shortcuts, agents) stays
    // beneath it when anything is left of it.
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {items.map((item, i) => (
            <Text>
              {i > 0 ? sep : null}
              {item as never}
            </Text>
          ))}
        </Text>
        {hint ? (
          <Text dimColor wrap="truncate-end">
            {hint}
          </Text>
        ) : null}
      </Box>
    )
  })
}
