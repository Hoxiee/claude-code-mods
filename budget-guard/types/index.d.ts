export type KeepaliveMode = 'on' | 'off'

/**
 * off: switched off; idle: on, but no cache to keep warm yet or the horizon is spent;
 * armed: on and will ping on schedule; pinging: a ping is running; paused: stopped by a failure.
 */
export type KeepaliveStatus = 'off' | 'idle' | 'armed' | 'pinging' | 'paused'

declare module 'claude-code' {
  interface PluginState {
    'budget-guard': { keepaliveMode: KeepaliveMode; keepaliveStatus: KeepaliveStatus }
  }
}
