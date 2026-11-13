import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Job } from '../types'

// Change the tag when Job's fields change: it declines what an earlier version stored.
const jobs = atom({ plugin: 'progress-bar', key: 'jobs' } as const, [] as Job[], { shape: 'jobs-1' })

const TICK_MS = 2000
const KEEP_DONE_MS = 60_000

const DESCRIPTION = [
  'Shows the person a live progress bar above the prompt for a long operation, so a wait never looks like idling.',
  'Call it as soon as you start anything that takes more than ~30 seconds (a download, a build, a render, a long copy or test run), with a short title in the person\'s language.',
  'For a download or any growing file, pass `file` (absolute path) and `total` (expected bytes): the bar then updates itself every 2 s with speed and time left, and closes when the file reaches `total`.',
  'For other work, pass `pct` (0–100) or `current`/`total`, and call again with the same `id` as it moves; add `note` for the current step.',
  'Call with `done: true` when it finishes or fails (or `remove: true` to drop it).',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable id of this operation, e.g. "model-download".' },
    title: { type: 'string', description: 'Short label shown in the bar.' },
    file: { type: 'string', description: 'Absolute path of a file whose size grows (download, render).' },
    total: { type: 'number', description: 'Expected final size in bytes (with file), or total units (with current).' },
    current: { type: 'number', description: 'Units done so far (without file).' },
    pct: { type: 'number', description: 'Percent done, 0–100.' },
    note: { type: 'string', description: 'Current step, shown dim after the bar.' },
    done: { type: 'boolean', description: 'Mark finished.' },
    remove: { type: 'boolean', description: 'Remove the bar.' },
  },
  required: ['id'],
}

type Input = {
  id: string; title?: string; file?: string; total?: number; current?: number
  pct?: number; note?: string; done?: boolean; remove?: boolean
}

function fraction(j: Job): number | undefined {
  if (j.doneAt) return 1
  if (j.pct !== undefined) return Math.max(0, Math.min(1, j.pct / 100))
  if (j.total && j.current !== undefined) return Math.max(0, Math.min(1, j.current / j.total))
  return undefined
}

function bytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' ГБ'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' МБ'
  if (n >= 1e3) return Math.round(n / 1e3) + ' КБ'
  return n + ' Б'
}

function duration(s: number): string {
  if (!isFinite(s) || s < 0) return '…'
  if (s < 60) return Math.max(1, Math.round(s)) + ' с'
  if (s < 3600) return Math.round(s / 60) + ' мин'
  const h = Math.floor(s / 3600)
  return h + ' ч ' + Math.round((s - h * 3600) / 60) + ' мин'
}

function eta(j: Job, now: number): number | undefined {
  const f = fraction(j)
  if (j.doneAt || f === undefined) return undefined
  if (j.total && j.current !== undefined && j.rate && j.rate > 0) return (j.total - j.current) / j.rate
  const el = (now - j.startedAt) / 1000
  if (f > 0.02 && el > 5) return el * (1 - f) / f
  return undefined
}

function line(j: Job, now: number, width: number): string {
  const f = fraction(j)
  const cells = width < 60 ? 8 : 12
  const fill = f === undefined ? 0 : Math.round(f * cells)
  const bar = '▰'.repeat(fill) + '▱'.repeat(cells - fill)
  const parts: string[] = []
  if (f !== undefined && !j.doneAt) parts.push(Math.floor(f * 100) + '%')
  if (j.doneAt) parts.push('готово')
  else {
    const left = eta(j, now)
    parts.push(left !== undefined ? '~' + duration(left) : duration((now - j.startedAt) / 1000))
  }
  return `${j.doneAt ? '✓' : '⏳'} ${j.title} ${bar} ${parts.join(' · ')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'progress', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })

    // Each tick: grow file-backed bars, close finished ones, drop old finished ones.
    $.clock.every(TICK_MS, async () => {
      const list = await read($, jobs)
      if (list.length === 0) return
      const now = await $.clock.now()
      const updated: Job[] = []
      for (const j of list) {
        if (j.doneAt) { if (now - j.doneAt < KEEP_DONE_MS) updated.push(j); continue }
        if (!j.file) { updated.push(j); continue }
        let size: number | undefined
        try { const st = await $.fs.stat(j.file); if (st.kind === 'file') size = st.size } catch { size = undefined }
        if (size === undefined) { updated.push(j); continue }
        let rate = j.rate
        if (j.lastValue !== undefined && j.lastAt !== undefined && now > j.lastAt) {
          const inst = (size - j.lastValue) / ((now - j.lastAt) / 1000)
          rate = rate === undefined ? inst : rate * 0.8 + inst * 0.2
        }
        const finished = j.total !== undefined && size >= j.total
        updated.push({ ...j, current: size, rate, lastValue: size, lastAt: now, doneAt: finished ? now : undefined })
      }
      await update($, jobs, () => updated)
      const live = updated.filter(j => !j.doneAt)
      $.ui.status(live.length ? line(live[0], now, 60) : undefined)
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__progress-bar__progress' }, async ($, e) => {
    const input = e as unknown as Input
    if (!input || typeof input.id !== 'string' || input.id === '') return { deny: 'progress: `id` is required' }
    const now = await $.clock.now()
    await update($, jobs, list => {
      if (input.remove) return list.filter(j => j.id !== input.id)
      const old = list.find(j => j.id === input.id)
      const base: Job = old ?? { id: input.id, title: input.title ?? input.id, startedAt: now }
      const j: Job = {
        ...base,
        title: input.title ?? base.title,
        file: input.file ?? base.file,
        total: input.total ?? base.total,
        current: input.current ?? base.current,
        pct: input.pct ?? base.pct,
        note: input.note ?? base.note,
        doneAt: input.done ? now : base.doneAt,
      }
      if (input.current !== undefined && !j.file && old?.current !== undefined && old.lastAt !== undefined && now > old.lastAt) {
        const inst = (input.current - old.current) / ((now - old.lastAt) / 1000)
        j.rate = old.rate === undefined ? inst : old.rate * 0.7 + inst * 0.3
      }
      if (input.current !== undefined) { j.lastValue = input.current; j.lastAt = now }
      return [...list.filter(x => x.id !== input.id), j]
    })
    if (input.done || input.remove) $.ui.status(undefined)
    const list = await read($, jobs)
    const j = list.find(x => x.id === input.id)
    return { result: j ? line(j, now, 60) : 'removed' }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: the progress bar failed to update` }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, jobs)
    if (list.length === 0) return next(e)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const width = e.viewport?.columns ?? 100
    return (
      <Box flexDirection="column">
        {list.map(j => (
          <Box key={j.id}>
            <Text color={j.doneAt ? 'green' : undefined}>{line(j, now, width)}</Text>
            {j.note && !j.doneAt ? <Text dimColor>{'  ' + j.note}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}
