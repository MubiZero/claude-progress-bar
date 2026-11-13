export type Job = {
  id: string
  title: string
  /** Growing file whose size is the progress (a download, a render). */
  file?: string
  /** Target: bytes when `file` is set, else any unit for `current`. */
  total?: number
  current?: number
  /** Percent 0–100 when given directly. */
  pct?: number
  note?: string
  startedAt: number
  /** Smoothed speed, units (bytes) per second. */
  rate?: number
  lastValue?: number
  lastAt?: number
  doneAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { jobs: Job[] }
  }
}
