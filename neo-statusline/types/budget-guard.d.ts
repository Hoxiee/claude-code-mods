// Read-only copy of the budget-guard mod's state contract: the cache keepalive indicator.
declare module 'claude-code' {
  interface PluginState {
    'budget-guard': { keepaliveStatus: 'off' | 'idle' | 'armed' | 'pinging' | 'paused' }
  }
}

export {}
