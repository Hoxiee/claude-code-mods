export type Snapshot = { path: string }

export type Screenshot = Snapshot & {
  id: string
  title: string
  origin: string
  capturedAt: number
  sourcePath?: string
  mimeType?: string
}

export type Gallery = {
  images: Screenshot[]
  page: number
  dismissed: boolean
  epoch: number
  query?: string
}

export type ImageInput = { base64: string; mimeType: string; title: string; sourcePath?: string }

declare module 'claude-code' {
  interface PluginState {
    'neo-screenshots': { gallery: Shaped<Gallery> }
  }
}
