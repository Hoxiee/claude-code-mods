import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'

const COMMAND = {
  command: 'screenshots', args: '', origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const PANE = {
  plugin: 'neo-screenshots',
  component: 'Pane',
  requestId: 'neo-screenshots',
  surface: 'terminal',
  props: {
    title: 'Скриншоты', isFocused: true, bodyColumns: 36, placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 }, view: {},
  },
} as const

const IMAGE = {
  type: 'image',
  file: { base64: 'aW1hZ2U=', type: 'image/png', originalSize: 5 },
}

type On = Parameters<TestBody>[1]

function world(on: On) {
  const state = {
    result: { result: IMAGE, text: 'исходный результат' } as ToolCallResult,
    captures: [] as object[],
    opens: [] as string[],
    panes: [] as string[],
    toasts: [] as string[],
    toolCalls: 0,
    failedCapture: false,
    failedOpen: false,
    gate: undefined as Promise<void> | undefined,
    started: undefined as (() => void) | undefined,
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'screenshots' } }))
  on('clock.now', () => ({ value: 1234 }))
  on('ui.open', (_, e) => {
    state.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => {
    state.toolCalls++
    return state.result
  })
  on('process.run', async (_, e) => {
    const input = JSON.parse(e.init?.stdin ?? '{}')
    const isCapture = e.argv.at(-1) === 'capture'
    let stdout = ''
    if (isCapture) {
      state.captures.push(input)
      state.started?.()
      await state.gate
      stdout = JSON.stringify({ path: `/tmp/neo-screenshots-test-${state.captures.length}/snapshot.png` })
    } else {
      state.opens.push(input.path)
      stdout = '{"opened":true}'
    }
    return { value: {
      exitCode: (isCapture ? state.failedCapture : state.failedOpen) ? 1 : 0,
      stdout, stderr: 'ошибка helper', isStdoutTruncated: false, isStderrTruncated: false,
    } }
  })
  return state
}

test('список показывает имя, путь, время и источник; клик открывает снимок без превью', async ($, on) => {
  const state = world(on)
  const result = await $.tool.call({ tool: 'Read', file_path: '/project/screen.png', tool_use_id: 'r1' })
  expect(result.result).toEqual(IMAGE)
  expect(result.text).toBe('исходный результат')
  expect(state.toolCalls).toBe(1)
  expect(state.captures).toEqual([{ base64: 'aW1hZ2U=', mimeType: 'image/png' }])
  expect(state.panes).toHaveLength(1)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'open:main:r1:0' }))?.text).toBe('screen.png')
  expect(await ui.find({ type: 'Text', text: '/project/screen.png' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /№1 · \d{2}:\d{2}:\d{2} · Read/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▀/ })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('"hotkey":"1"')
  await ui.press({ key: 'open:main:r1:0' })
  expect(state.opens).toEqual(['/tmp/neo-screenshots-test-1/snapshot.png'])
  await ui.unmount()
})

test('MCP собирает все image blocks, путь из input и вызовы subagent', async ($, on) => {
  const state = world(on)
  state.result = { result: { content: [
    { type: 'text', text: 'снимки' },
    { type: 'image', data: 'YQ==', mimeType: 'image/png' },
    { type: 'image', source: { type: 'base64', data: 'Yg==', media_type: 'image/jpeg' } },
  ] } }
  await $.tool.call({
    tool: 'mcp__camera__snapshot', tool_use_id: 'm1', agentId: 'a1',
    input: { filePath: '/screens/browser.png' },
  })
  expect(state.captures).toHaveLength(2)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'open:a1:m1:0' })).toBeDefined()
  expect(await ui.find({ key: 'open:a1:m1:1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /агент a1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/screens/browser.png' })).toBeDefined()
  await ui.input({ key: 'query', text: 'JPEG camera', kind: 'change' })
  expect(await ui.find({ key: 'open:a1:m1:0' })).toBeUndefined()
  expect(await ui.find({ key: 'open:a1:m1:1' })).toBeDefined()
  await ui.unmount()
})

test('поиск отличает одинаковые имена по пути и сбрасывается без открытия файлов', async ($, on) => {
  const state = world(on)
  await $.tool.call({ tool: 'Read', file_path: '/first/screen.png', tool_use_id: 'r1' })
  await $.tool.call({ tool: 'Read', file_path: '/second/screen.png', tool_use_id: 'r2' })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'query', text: 'FIRST SCREEN', kind: 'change' })
  expect(await ui.find({ key: 'open:main:r1:0' })).toBeDefined()
  expect(await ui.find({ key: 'open:main:r2:0' })).toBeUndefined()
  await ui.input({ key: 'query', text: 'FIRST SCREEN' })
  await ui.input({ key: 'query', text: 'нет-совпадений', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /Ничего не найдено/ })).toBeDefined()
  expect(await ui.find({ key: 'open:main:r1:0' })).toBeUndefined()
  await ui.press({ key: 'reset-query' })
  expect(await ui.find({ key: 'open:main:r1:0' })).toBeDefined()
  expect(await ui.find({ key: 'open:main:r2:0' })).toBeDefined()
  expect(state.opens).toHaveLength(0)
  expect(state.captures).toHaveLength(2)
  await ui.unmount()
})

test('текстовые, отказанные и ошибочные результаты не попадают в список', async ($, on) => {
  const state = world(on)
  for (const result of [
    { result: { type: 'text' } },
    { result: IMAGE, isError: true as const },
    { deny: 'запрещено' },
  ]) {
    state.result = result
    await $.tool.call({ tool: 'Read', file_path: '/x.png' })
  }
  state.result = { result: { isError: true, content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] } }
  await $.tool.call({ tool: 'mcp__camera__snapshot', input: {} })
  expect(state.captures).toHaveLength(0)
})

test('повтор одного tool id не дублируется, новое чтение того же пути сохраняется', async ($, on) => {
  const state = world(on)
  for (const id of ['r1', 'r1', 'r2']) {
    await $.tool.call({ tool: 'Read', file_path: '/x.png', tool_use_id: id })
  }
  expect(state.captures).toHaveLength(2)
})

test('параллельные чтения не теряются', async ($, on) => {
  const state = world(on)
  await Promise.all(['one', 'two', 'three'].map(id =>
    $.tool.call({ tool: 'Read', file_path: `/${id}.png`, tool_use_id: id }),
  ))
  expect(state.captures).toHaveLength(3)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Скриншоты ·/ }))?.text).toBe('Скриншоты · 3')
  await ui.unmount()
})

test('сбой helper не меняет успешный результат Read и не повторяет инструмент', async ($, on) => {
  const state = world(on)
  state.failedCapture = true
  const result = await $.tool.call({ tool: 'Read', file_path: '/x.png' })
  expect(result.result).toEqual(IMAGE)
  expect(state.toolCalls).toBe(1)
  expect(state.toasts).toHaveLength(1)
})

test('ошибка системного просмотрщика видна пользователю', async ($, on) => {
  const state = world(on)
  state.failedOpen = true
  await $.tool.call({ tool: 'Read', file_path: '/x.png', tool_use_id: 'r1' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'open:main:r1:0' })
  expect(state.toasts).toHaveLength(1)
  expect(state.toasts[0]).toContain('Не удалось открыть')
  await ui.unmount()
})

test('пагинация показывает новые сверху; поиск сбрасывает страницу', async ($, on) => {
  const state = world(on)
  for (let i = 0; i < 12; i++) {
    await $.tool.call({ tool: 'Read', file_path: `/${i}.png`, tool_use_id: `r${i}` })
  }
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'open:main:r0:0' })).toBeUndefined()
  expect(await ui.find({ key: 'open:main:r11:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1–9 из 12' })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ key: 'open:main:r0:0' })).toBeDefined()
  expect(await ui.find({ key: 'open:main:r11:0' })).toBeUndefined()
  await ui.input({ key: 'query', text: '11.png', kind: 'change' })
  expect(await ui.find({ key: 'open:main:r11:0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1–1 из 1' })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /Здесь появятся/ })).toBeDefined()
  expect(await ui.find({ key: 'reset-query' })).toBeUndefined()
  expect(state.opens).toHaveLength(0)
  await ui.unmount()
})

test('очистка не возвращает снимок из незавершённого сохранения', async ($, on) => {
  const state = world(on)
  let release!: () => void
  state.gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { state.started = resolve })
  const pending = $.tool.call({ tool: 'Read', file_path: '/x.png', tool_use_id: 'r1' })
  await started
  await $.command.run({ ...COMMAND, args: 'clear' })
  release()
  await pending
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Здесь появятся/ })).toBeDefined()
  await ui.unmount()
})

test('команда открывает панель, неизвестные аргументы не вызывают процесс', async ($, on) => {
  const state = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...COMMAND })
  expect(state.panes).toHaveLength(1)
  const result = await $.command.run({ ...COMMAND, args: 'oops' })
  expect(result.text).toContain('Использование')
  expect(state.captures).toHaveLength(0)
})

test('снимки версии с превью переживают hot reload без повторной обработки', async ($, on) => {
  const state = world(on)
  let stored: unknown = { shape: 'gallery-1', value: {
    images: [{
      id: 'legacy', path: '/tmp/neo-screenshots-old/snapshot.png', title: 'old.png',
      origin: 'Read', capturedAt: 1234,
      thumbnail: { width: 1, height: 1, pixels: 'ff0000' }, warning: 'Старая миниатюра',
    }],
    page: 0, dismissed: false, epoch: 0,
  } }
  let version = 1
  on('state.get', () => ({ value: { value: stored, version } }))
  on('state.set', (_, e) => {
    stored = e.value
    return { value: { isSet: true, version: ++version } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'open:legacy' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Путь не указан' })).toBeDefined()
  expect(JSON.stringify(stored)).not.toContain('thumbnail')
  expect(JSON.stringify(stored)).not.toContain('warning')
  await ui.press({ key: 'open:legacy' })
  expect(state.opens).toEqual(['/tmp/neo-screenshots-old/snapshot.png'])
  expect(state.captures).toHaveLength(0)
  await ui.unmount()
})

test('неизвестная форма состояния отклоняется, остальные панели не меняются', async ($, on) => {
  world(on)
  on('state.get', () => ({ value: { value: { images: ['old'] }, version: 1 } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Здесь появятся/ })).toBeDefined()
  await ui.unmount()
  const other = await $.ui.mount({ ...PANE, requestId: 'another' })
  expect(await other.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await other.unmount()
})

test('маленькая панель уменьшает страницу, на остальных поверхностях есть список', async ($, on) => {
  world(on)
  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: 'Read', file_path: `/${i}.png`, tool_use_id: `r${i}` })
  }
  const narrow = await $.ui.mount({ ...PANE, props: {
    ...PANE.props, bodyColumns: 12, scroll: { offset: 0, bodyRows: 12 },
  } })
  expect(await narrow.find({ type: 'Text', text: '1–2 из 3' })).toBeDefined()
  expect(await narrow.find({ key: 'open:main:r0:0' })).toBeUndefined()
  await narrow.unmount()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'open:main:r0:0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▀/ })).toBeUndefined()
    await ui.unmount()
  }
})
