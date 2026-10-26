import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Gallery, ImageInput, Screenshot, Snapshot } from '../types'

const PANE = 'neo-screenshots'
const emptyGallery = (): Gallery => ({ images: [], page: 0, dismissed: false, epoch: 0, query: '' })
const gallery = atom({ plugin: 'neo-screenshots', key: 'gallery' } as const, emptyGallery(), {
  shape: 'gallery-1',
})

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function label(value: string, limit = 160): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '�').slice(0, limit)
}

function filename(path: string): string {
  return label(path.replace(/\\/g, '/').split('/').at(-1) || 'Изображение')
}

function imagesFromResult(tool: string, input: unknown, result: unknown): ImageInput[] {
  if (tool === 'Read' && record(result) && result.type === 'image' && record(result.file)) {
    const file = result.file
    if (typeof file.base64 !== 'string' || typeof file.type !== 'string') return []
    const path = record(input) && typeof input.file_path === 'string' ? input.file_path : ''
    return [{
      base64: file.base64, mimeType: file.type, title: filename(path),
      ...(path ? { sourcePath: label(path, 4096) } : {}),
    }]
  }
  if (!tool.startsWith('mcp__')) return []
  if (record(result) && result.isError === true) return []
  const blocks = Array.isArray(result) ? result : record(result) ? result.content : undefined
  if (!Array.isArray(blocks)) return []
  const args = record(input) && record(input.input) ? input.input : input
  const path = record(args) ? args.filePath ?? args.file_path ?? args.path : undefined
  const images: ImageInput[] = []
  for (const block of blocks) {
    if (!record(block) || block.type !== 'image') continue
    const source = record(block.source) && block.source.type === 'base64' ? block.source : block
    const base64 = source.data
    const mimeType = source.media_type ?? source.mimeType
    if (typeof base64 !== 'string' || typeof mimeType !== 'string') continue
    images.push({
      base64, mimeType, title: typeof path === 'string' ? filename(path) : 'Скриншот',
      ...(typeof path === 'string' && path ? { sourcePath: label(path, 4096) } : {}),
    })
  }
  return images
}

function snapshotFromJson(text: string): Snapshot {
  const value: unknown = JSON.parse(text)
  if (!record(value) || typeof value.path !== 'string' || !value.path.startsWith('/')) {
    throw new Error('Неверный ответ хранилища снимков')
  }
  return { path: value.path }
}

function matchingImages(value: Gallery) {
  const words = (value.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  return value.images.map((image, index) => ({ image, number: index + 1 })).filter(({ image }) => {
    const text = [image.title, image.sourcePath, image.origin, image.mimeType].join(' ').toLowerCase()
    return words.every(word => text.includes(word))
  }).reverse()
}

function timeLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '—'
  return new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

async function helper($: EngineInterface, action: 'capture' | 'open', input: object) {
  const result = await $.process.run(
    ['python3', '-I', `${$.plugin.root}/scripts/image-cache.py`, action],
    { stdin: JSON.stringify(input), timeoutMs: 20_000 },
  )
  if (result.exitCode !== 0 || result.isStdoutTruncated) {
    throw new Error(label(result.stderr.trim() || 'Не удалось обработать снимок'))
  }
  return result.stdout
}

async function openImage($: EngineInterface, image: Screenshot) {
  try {
    await helper($, 'open', { path: image.path })
  } catch (error) {
    $.ui.toast(`Не удалось открыть изображение: ${label(String(error))}`)
  }
}

async function resetGallery($: EngineInterface, dismissed = true) {
  await update($, gallery, value => ({ ...emptyGallery(), epoch: value.epoch + 1, dismissed }))
}

export const register: Register = (on, options) => {
  const inFlight = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'screenshots',
      description: 'Открыть список прочитанных изображений; screenshots clear очищает список',
    })
    // При hot reload сохраняем снимки, но больше не держим пиксели старых превью.
    await update($, gallery, value => ({
      ...value, query: value.query ?? '',
      images: value.images.map(image => ({
        id: image.id, path: image.path, title: image.title,
        origin: image.origin, capturedAt: image.capturedAt,
        ...(image.sourcePath ? { sourcePath: image.sourcePath } : {}),
        ...(image.mimeType ? { mimeType: image.mimeType } : {}),
      })),
    }))
    return next(e)
  })

  on('command.run', { command: 'screenshots' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await resetGallery($)
      return { text: 'Список скриншотов очищен. Исходные файлы не изменены.' }
    }
    if (e.args.trim()) return { text: 'Использование: /screenshots или /screenshots clear' }
    await update($, gallery, value => ({ ...value, dismissed: false }))
    const opened = await $.ui.open({ id: PANE, title: 'Скриншоты', focus: true, columns: 44, rows: 28 })
    return { text: opened.isPlaced ? '' : 'Список откроется, когда интерфейс сможет его разместить.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'person') {
      await update($, gallery, value => ({ ...value, dismissed: true }))
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    await resetGallery($, false)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result
    const inputs = imagesFromResult(e.tool, e, result.result)
    if (!inputs.length) return result

    // Сбой списка не должен менять результат инструмента или повторять его вызов.
    try {
      const before = await read($, gallery)
      const origin = label(`${e.tool}${e.agentId ? ` · агент ${e.agentId}` : ''}`)
      for (const [index, input] of inputs.entries()) {
        const id = `${e.agentId ?? 'main'}:${e.tool_use_id}:${index}`
        if (inFlight.has(id) || before.images.some(image => image.id === id)) continue
        inFlight.add(id)
        try {
          const snapshot = snapshotFromJson(await helper($, 'capture', {
            base64: input.base64, mimeType: input.mimeType,
          }))
          const image: Screenshot = {
            ...snapshot, id, title: input.title, origin, capturedAt: await $.clock.now(),
            mimeType: input.mimeType,
            ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
          }
          let shouldOpen = false
          await update($, gallery, value => {
            shouldOpen = false
            if (value.epoch !== before.epoch || value.images.some(item => item.id === id)) return value
            shouldOpen = options.autoOpen !== false && !value.dismissed && value.images.length === 0
            return { ...value, images: [...value.images, image] }
          })
          if (shouldOpen) await $.ui.open({ id: PANE, title: 'Скриншоты', columns: 44, rows: 28 })
        } catch (error) {
          $.ui.log(`Не удалось сохранить ${input.title}: ${label(String(error))}`, { to: 'debug' })
          $.ui.toast(`Скриншоты: не удалось сохранить ${input.title}`)
        } finally {
          inFlight.delete(id)
        }
      }
    } catch (error) {
      $.ui.log(`Не удалось обновить список: ${label(String(error))}`, { to: 'debug' })
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const value = await read($, gallery)
    const matches = matchingImages(value)
    const pageSize = Math.max(1, Math.min(9, Math.floor((e.props.scroll.bodyRows - 6) / 3)))
    const pages = Math.max(1, Math.ceil(matches.length / pageSize))
    const page = Math.min(value.page, pages - 1)
    const start = page * pageSize
    const rows = matches.slice(start, start + pageSize)
    const columns = Math.max(1, e.props.bodyColumns - 2)
    const setQuery = (query: string) => update($, gallery, current => ({
      ...current, query: label(query, 200), page: 0,
    }))
    const navigate = (delta: number) => update($, gallery, current => ({
      ...current,
      page: Math.max(0, Math.min(page + delta, Math.ceil(matchingImages(current).length / pageSize) - 1)),
    }))
    let search = null
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Input } = $.ui.resolve(e)
      search = (
        <Input key="query" label="Поиск" placeholder="Имя, путь, источник" value={value.query ?? ''}
          submitLabel="найти" onInput={query => setQuery(query)} onSubmit={query => setQuery(query)} />
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Скриншоты · {value.images.length}</Text>
        {search}
        {value.query && <Button key="reset-query" label="Сбросить поиск" plain dimColor onPress={() => setQuery('')} />}
        {value.images.length === 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Здесь появятся изображения из Read и MCP, прочитанные после включения мода.</Text>
          </Box>
        ) : matches.length === 0 ? (
          <Text dimColor>Ничего не найдено. Измени запрос.</Text>
        ) : (
          <Box flexDirection="column">
            <Box gap={1} flexWrap="wrap">
              {page > 0 && <Button key="previous" label="Новее" onPress={() => navigate(-1)} />}
              <Text dimColor>{start + 1}–{start + rows.length} из {matches.length}</Text>
              {page + 1 < pages && <Button key="next" label="Старее" onPress={() => navigate(1)} />}
            </Box>
            {rows.map(({ image, number }, index) => (
              <Box key={image.id} flexDirection="column" width={columns}>
                <Button key={`open:${image.id}`} label={image.title} hotkey={String(index + 1)} plain
                  onPress={() => openImage($, image)}>
                  <Text wrap="truncate-middle">{image.title}</Text>
                </Button>
                <Text dimColor wrap="truncate-end">№{number} · {timeLabel(image.capturedAt)} · {image.origin.replace(/^mcp__/, '').replace(/__/g, ' / ')}</Text>
                <Text dimColor wrap="truncate-middle">{image.sourcePath ?? 'Путь не указан'}</Text>
              </Box>
            ))}
          </Box>
        )}
        <Text dimColor>Клик / Enter — открыть · Tab — выбор</Text>
        {value.images.length > 0 && <Button key="clear" label="Очистить список" dimColor onPress={() => resetGallery($)} />}
      </Box>
    )
  })
}
