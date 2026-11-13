export type Job = {
  id: string
  title: string
  /** manual — Claude calls `progress`; cmd — a long foreground command; bg — a background command. */
  kind: 'manual' | 'cmd' | 'bg'
  /** Growing file whose size is the progress (a download, a render). */
  file?: string
  /** With `file`: a regex; progress is the count of matching lines in it (an agent's report, a log), the last is the note. */
  count?: string
  /** When the counted lines last grew (the step the bar moves on from). */
  stepAt?: number
  /** Target: bytes when `file` is set, else any unit for `current`. */
  total?: number
  current?: number
  /** Percent 0–100 when given directly or read from a command's output. */
  pct?: number
  note?: string
  startedAt: number
  /** Smoothed speed, units (bytes) per second. */
  rate?: number
  lastValue?: number
  lastAt?: number
  /** Last time the file or the output grew, or Claude sent an update. */
  lastMoveAt?: number
  doneAt?: number
  failed?: boolean
  /** Background task id and its output file. */
  taskId?: string
  outFile?: string
  /** Key of past durations kept across sessions, and their mean. */
  histKey?: string
  expectMs?: number
  notified?: boolean
}

export type PlanStep = { content: string; status: 'pending' | 'in_progress' | 'completed' }

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { jobs: Job[]; plan: PlanStep[] }
  }
}
