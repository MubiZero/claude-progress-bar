import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, PlanStep } from '../types'

// Change a tag when the stored fields change: it declines what an earlier version stored.
const jobs = atom({ plugin: 'progress-bar', key: 'jobs' } as const, [] as Job[], { shape: 'jobs-3' })
const plan = atom({ plugin: 'progress-bar', key: 'plan' } as const, [] as PlanStep[], { shape: 'plan-1' })

const TICK_MS = 2000
const KEEP_DONE_MS = 60_000
const CMD_SHOW_AFTER_MS = 15_000     // a foreground command gets a bar once it runs this long
const NOTIFY_MIN_MS = 30_000         // notify only about work that took at least this long
const FILE_STALL_MS = 60_000         // a download that has not grown this long is stuck
const QUIET_MS = 5 * 60_000          // a command or manual bar with no news this long is flagged

const DESCRIPTION = [
  'Shows the person a live progress bar above the prompt for a long operation, so a wait never looks like idling.',
  'Long commands you run are tracked by themselves (elapsed time, a percent read from their output, time left from past runs), so call this tool for what that cannot see:',
  'a download or any growing file — pass `file` (absolute path) and `total` (expected bytes) and the bar updates itself with speed and time left;',
  'or a multi-step job — pass `pct` (0–100) or `current`/`total` and call again with the same `id` as it moves; add `note` for the current step;',
  'or work that writes as it goes (an agent\'s report, a log) — pass `file` and `count` (a regex): the bar counts the matching lines by itself, moves on each new one and shows the last as the step, so nobody has to call again (with `total`, it ends at that many).',
  'Use a short title in the person\'s language. Call with `done: true` when it finishes, `failed: true` when it fails, or `remove: true` to drop it.',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable id of this operation, e.g. "model-download".' },
    title: { type: 'string', description: 'Short label shown in the bar.' },
    file: { type: 'string', description: 'Absolute path of a file whose size grows (download, render), or that `count` reads.' },
    count: { type: 'string', description: 'With `file`: a regex; progress is the number of matching lines (e.g. "^## День" in a report a long job writes), the last match is the step.' },
    total: { type: 'number', description: 'Expected final size in bytes (with file), or total units (with current).' },
    current: { type: 'number', description: 'Units done so far (without file).' },
    pct: { type: 'number', description: 'Percent done, 0–100.' },
    note: { type: 'string', description: 'Current step, shown dim after the bar.' },
    done: { type: 'boolean', description: 'Mark finished.' },
    failed: { type: 'boolean', description: 'Mark failed.' },
    remove: { type: 'boolean', description: 'Remove the bar.' },
  },
  required: ['id'],
}

type Input = {
  id: string; title?: string; file?: string; count?: string; total?: number; current?: number
  pct?: number; note?: string; done?: boolean; failed?: boolean; remove?: boolean
}

// ---------- formatting ----------

function bytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' ГБ'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' МБ'
  if (n >= 1e3) return Math.round(n / 1e3) + ' КБ'
  return n + ' Б'
}

/** «556/783 МБ»: one unit for the pair. */
function size2(cur: number, total: number): string {
  const [d, u] = total >= 1e9 ? [1e9, 'ГБ'] : total >= 1e6 ? [1e6, 'МБ'] : [1e3, 'КБ']
  const fmt = (n: number) => (n / d >= 100 || d === 1e3 ? String(Math.round(n / d)) : (n / d).toFixed(1))
  return fmt(cur) + '/' + fmt(total) + ' ' + u
}

function duration(s: number): string {
  if (!isFinite(s) || s < 0) return '…'
  if (s < 60) return Math.max(1, Math.round(s)) + ' с'
  if (s < 3600) return Math.round(s / 60) + ' мин'
  const h = Math.floor(s / 3600)
  return h + ' ч ' + Math.round((s - h * 3600) / 60) + ' мин'
}

/** Share done, 0–1, or undefined when unknown. `guess` — taken from past runs, not measured. */
function fraction(j: Job, now: number): { f?: number; guess: boolean } {
  if (j.doneAt) return { f: 1, guess: false }
  // Counted steps: between two of them the bar moves on by the mean step so far, never past the next one.
  if (j.count && j.total && j.current !== undefined && j.current > 0 && j.stepAt) {
    const mean = (j.stepAt - j.startedAt) / j.current
    const part = mean > 0 ? Math.min(0.9, (now - j.stepAt) / mean) : 0
    return { f: Math.max(0, Math.min(0.99, (j.current + part) / j.total)), guess: false }
  }
  if (j.total && j.current !== undefined) return { f: Math.max(0, Math.min(1, j.current / j.total)), guess: false }
  if (j.pct !== undefined) return { f: Math.max(0, Math.min(1, j.pct / 100)), guess: false }
  if (j.expectMs) return { f: Math.min(0.95, (now - j.startedAt) / j.expectMs), guess: true }
  return { guess: false }
}

function eta(j: Job, now: number): number | undefined {
  if (j.doneAt) return undefined
  if (j.total && j.current !== undefined && j.rate && j.rate > 0) return (j.total - j.current) / j.rate
  const el = (now - j.startedAt) / 1000
  const { f, guess } = fraction(j, now)
  if (guess && j.expectMs) return Math.max(1, j.expectMs / 1000 - el)
  if (f !== undefined && f > 0.02 && el > 5) return el * (1 - f) / f
  return undefined
}

/** A file whose size is the progress (a download), not one whose lines are counted. */
const bySize = (j: Job) => !!j.file && !j.count

function stalledFor(j: Job, now: number): number {
  if (j.doneAt) return 0
  const since = now - (j.lastMoveAt ?? j.startedAt)
  const limit = bySize(j) ? FILE_STALL_MS : QUIET_MS
  return since > limit ? since : 0
}

function line(j: Job, now: number, width: number): string {
  const { f } = fraction(j, now)
  const cells = width < 60 ? 8 : 12
  const fill = f === undefined ? 0 : Math.round(f * cells)
  // Nothing measured yet: a block runs along the bar, so live work never looks frozen.
  const idle = !j.doneAt && fill === 0
  const at = Math.floor(now / 1000) % cells
  const bar = idle ? [...Array(cells)].map((_, i) => (i === at ? '▰' : '▱')).join('') : '▰'.repeat(fill) + '▱'.repeat(cells - fill)
  const parts: string[] = []
  if (j.doneAt) {
    parts.push((j.failed ? 'ошибка через ' : 'готово за ') + duration((j.doneAt - j.startedAt) / 1000))
  } else {
    const { f: g, guess } = fraction(j, now)
    if (g !== undefined && !guess && g > 0) parts.push(Math.floor(g * 100) + '%')
    if (bySize(j) && j.current !== undefined) parts.push(j.total ? size2(j.current, j.total) : bytes(j.current))
    else if (j.total && j.current !== undefined) parts.push(j.current + '/' + j.total)
    if (bySize(j) && j.rate && j.rate > 0) parts.push(bytes(j.rate) + '/с')
    const stall = stalledFor(j, now)
    if (stall) parts.push((bySize(j) ? 'застряло ' : 'тихо ') + duration(stall / 1000))
    const left = eta(j, now)
    parts.push(left !== undefined ? '~' + duration(left) : 'идёт ' + duration((now - j.startedAt) / 1000))
  }
  const mark = j.doneAt ? (j.failed ? '✗' : '✓') : '⏳'
  return `${mark} ${j.title} ${bar} ${parts.join(' · ')}`
}

// ---------- history of durations (across sessions) ----------

function histKeyOf(s: string): string {
  return 'hist:' + s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80)
}

async function expectFor($: EngineInterface, key: string): Promise<number | undefined> {
  const v = (await $.store.get(key)) as number[] | undefined
  if (!Array.isArray(v) || v.length === 0) return undefined
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]   // median of the last runs
}

async function remember($: EngineInterface, key: string | undefined, ms: number) {
  if (!key || ms < 5000) return
  const v = ((await $.store.get(key)) as number[] | undefined) ?? []
  await $.store.set(key, [...v, Math.round(ms)].slice(-5))
}

// ---------- notification when long work ends ----------

async function announce($: EngineInterface, j: Job) {
  if (!j.doneAt || j.notified || j.doneAt - j.startedAt < NOTIFY_MIN_MS) return
  const text = `${j.failed ? '✗ Ошибка' : '✓ Готово'}: ${j.title} (${duration((j.doneAt - j.startedAt) / 1000)})`
  let sent = false
  try { sent = (await $.ui.notify(text, { title: 'Claude' })).isSent } catch { sent = false }
  if (!sent) {
    const esc = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    try {
      await $.process.run(['osascript', '-e', `display notification "${esc}" with title "Claude" sound name "${j.failed ? 'Basso' : 'Glass'}"`])
    } catch { /* not macOS: the toast below is all there is */ }
  }
  $.ui.toast(text)
}

// ---------- reading a background command's output ----------

const EXIT_RE = /\[exited with code (\d+)\]/
const PCT_RES = [/\[\s*(\d{1,3})%\]/g, /(?:^|\s)(\d{1,3}(?:\.\d)?)%\s*$/gm]

function pctFrom(tail: string): number | undefined {
  let best: { at: number; v: number } | undefined
  for (const re of PCT_RES) {
    for (const m of tail.matchAll(re)) {
      const v = parseFloat(m[1])
      if (v >= 0 && v <= 100 && (!best || (m.index ?? 0) >= best.at)) best = { at: m.index ?? 0, v }
    }
  }
  return best?.v
}

async function findOutput($: EngineInterface, taskId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return undefined
  try {
    const r = await $.process.run(['/bin/sh', '-c', `ls -t /private/tmp/claude-*/*/*/tasks/${taskId}.output /tmp/claude-*/*/*/tasks/${taskId}.output 2>/dev/null | head -1`])
    const p = r.stdout.trim()
    return p || undefined
  } catch { return undefined }
}

/** `curl … -o FILE URL` or `wget -O FILE URL` with an absolute FILE (or one under a `cd /abs &&`). */
function downloadOf(cmd: string): { file: string; url: string } | undefined {
  const m = cmd.match(/\b(curl|wget)\b([^|;&]*)/)
  if (!m) return undefined
  const args = m[2]
  const o = args.match(/\s-(?:o|O|-output|-output-document)[=\s]+("[^"]+"|'[^']+'|\S+)/)
  const u = args.match(/(https?:\/\/[^\s"']+)/)
  if (!o || !u) return undefined
  let file = o[1].replace(/^["']|["']$/g, '')
  if (!file.startsWith('/')) {
    const cd = cmd.match(/\bcd\s+("[^"]+"|'[^']+'|\/\S+)\s*&&/)
    if (!cd) return undefined
    file = cd[1].replace(/^["']|["']$/g, '').replace(/\/$/, '') + '/' + file
  }
  return { file, url: u[1] }
}

async function sizeAt($: EngineInterface, url: string): Promise<number | undefined> {
  try {
    const r = await $.http.fetch(url, { method: 'HEAD' })
    const n = Number(r.headers['content-length'] ?? r.headers['Content-Length'])
    return n > 0 ? n : undefined
  } catch { return undefined }
}

// ---------- jobs ----------

async function put($: EngineInterface, j: Job) {
  await update($, jobs, list => [...list.filter(x => x.id !== j.id), j])
}

async function finish($: EngineInterface, id: string, failed: boolean) {
  const now = await $.clock.now()
  let ended: Job | undefined
  await update($, jobs, list => list.map(x => {
    if (x.id !== id || x.doneAt) return x
    ended = { ...x, doneAt: now, failed }
    return ended
  }))
  if (ended) {
    if (!failed) await remember($, ended.histKey, now - ended.startedAt)
    await announce($, ended)
    await update($, jobs, list => list.map(x => (x.id === id ? { ...x, notified: true } : x)))
  }
}

// ---------- the mod ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'progress', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    $.ui.status(undefined)   // 0.1.0 wrote a status-line entry; there is none any more

    // Each tick: grow file bars, read background output, catch the stuck, end the finished.
    $.clock.every(TICK_MS, async () => {
      const list = await read($, jobs)
      if (list.length === 0) return
      const now = await $.clock.now()
      const kept: Job[] = []
      const ended: { id: string; failed: boolean }[] = []
      for (const j0 of list) {
        let j = j0
        if (j.doneAt) { if (now - j.doneAt < KEEP_DONE_MS) kept.push(j); continue }
        if (j.file && j.count) {
          // Lines that match: each new one moves the bar, the last one is the step («## День 6 (разбор хвоста)»).
          try {
            const r = await $.process.run(['grep', '-E', '--', j.count, j.file])
            const hits = r.stdout.split('\n').filter(x => x.trim() !== '')
            const n = hits.length
            const moved = j.lastValue === undefined || n !== j.lastValue
            const step = hits[n - 1]?.replace(/^[#\s*>-]+/, '').trim().slice(0, 60)
            j = { ...j, current: n, lastValue: n, lastAt: now, lastMoveAt: moved ? now : j.lastMoveAt, stepAt: moved && n > 0 ? now : j.stepAt, note: step || j.note }
            if (j.total !== undefined && n >= j.total) ended.push({ id: j.id, failed: false })
          } catch { /* no file yet, or no match: grep says so with a non-zero exit */ }
        } else if (j.file) {
          let size: number | undefined
          try { const st = await $.fs.stat(j.file); if (st.kind === 'file') size = st.size } catch { size = undefined }
          if (size !== undefined) {
            let rate = j.rate
            if (j.lastValue !== undefined && j.lastAt !== undefined && now > j.lastAt) {
              const inst = (size - j.lastValue) / ((now - j.lastAt) / 1000)
              rate = rate === undefined ? inst : rate * 0.8 + inst * 0.2
            }
            const grew = j.lastValue === undefined || size > j.lastValue
            j = { ...j, current: size, rate, lastValue: size, lastAt: now, lastMoveAt: grew ? now : j.lastMoveAt }
            if (j.total !== undefined && size >= j.total && !j.taskId) ended.push({ id: j.id, failed: false })
          }
        }
        if (j.outFile) {
          try {
            const st = await $.fs.stat(j.outFile)
            const r = await $.process.run(['tail', '-c', '6000', j.outFile])
            const tail = r.stdout
            if (!j.file) {
              const moved = j.lastValue === undefined || st.size !== j.lastValue
              j = { ...j, lastValue: st.size, lastMoveAt: moved ? now : j.lastMoveAt }
              const pct = pctFrom(tail)
              if (pct !== undefined) j = { ...j, pct }
            }
            const ex = tail.match(EXIT_RE)
            if (ex) ended.push({ id: j.id, failed: ex[1] !== '0' })
          } catch { /* output not there yet */ }
        }
        kept.push(j)
      }
      await update($, jobs, () => kept)
      for (const x of ended) await finish($, x.id, x.failed)
    })

    return next(e)
  })

  // ----- Claude's own calls -----
  on('tool.call', { tool: 'mcp__progress-bar__progress' }, async ($, e) => {
    const input = e as unknown as Input
    if (!input || typeof input.id !== 'string' || input.id === '') return { deny: 'progress: `id` is required' }
    const now = await $.clock.now()
    const list = await read($, jobs)
    if (input.remove) {
      await update($, jobs, l => l.filter(j => j.id !== input.id))
      return { result: 'removed' }
    }
    // the same file is already tracked from a download command: take that bar over
    const twin = input.file ? list.find(j => j.file === input.file && j.id !== input.id && !j.doneAt) : undefined
    const old = list.find(j => j.id === input.id) ?? twin
    // «done» for a bar that already ended by itself (a `count` bar at its total) and left: nothing to draw again.
    if (!old && (input.done || input.failed) && input.title === undefined) return { result: 'already finished' }
    const title = input.title ?? old?.title ?? input.id
    const histKey = old?.histKey ?? histKeyOf(title)
    const base: Job = old ?? { id: input.id, title, kind: 'manual', startedAt: now, histKey, expectMs: await expectFor($, histKey) }
    const j: Job = {
      ...base,
      title,
      file: input.file ?? base.file,
      count: input.count ?? base.count,
      total: input.total ?? base.total,
      current: input.current ?? base.current,
      pct: input.pct ?? base.pct,
      note: input.note ?? base.note,
      lastMoveAt: now,
    }
    if (input.current !== undefined && !j.file && old?.current !== undefined && old.lastAt !== undefined && now > old.lastAt) {
      const inst = (input.current - old.current) / ((now - old.lastAt) / 1000)
      j.rate = old.rate === undefined ? inst : old.rate * 0.7 + inst * 0.3
    }
    if (input.current !== undefined) { j.lastValue = input.current; j.lastAt = now }
    await put($, j)
    if (input.done || input.failed) await finish($, j.id, !!input.failed)
    const after = (await read($, jobs)).find(x => x.id === j.id)
    return { result: after ? line(after, now, 60) : 'removed' }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: the progress bar failed to update` }))

  // ----- commands Claude runs: long foreground ones and background ones -----
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const title = (e.description || e.command.split('\n')[0]).slice(0, 60)
    const histKey = histKeyOf(e.description || e.command.slice(0, 60))
    const start = await $.clock.now()

    if (e.run_in_background) {
      const ran = await next(e)
      try {
        const taskId = ran.deny === undefined && !ran.isError ? ran.result?.backgroundTaskId : undefined
        if (taskId) {
          const dl = downloadOf(e.command)
          const total = dl ? await sizeAt($, dl.url) : undefined
          await put($, {
            id: 'bg-' + taskId, title, kind: 'bg', startedAt: start, taskId, histKey,
            outFile: await findOutput($, taskId),
            file: dl?.file, total,
            expectMs: total ? undefined : await expectFor($, histKey),
          })
        }
      } catch { /* the bar is a convenience: never fail the command */ }
      return ran
    }

    // foreground: show a bar only once it has run a while
    const id = 'cmd-' + (e.tool_use_id ?? String(start))
    const expectMs = await expectFor($, histKey)
    const t = $.clock.after(CMD_SHOW_AFTER_MS, () => {
      void put($, { id, title, kind: 'cmd', startedAt: start, histKey, expectMs, lastMoveAt: start })
    })
    try {
      const ran = await next(e)
      const failed = ran.deny !== undefined || ran.isError === true || ran.result?.interrupted === true
      t.cancel()
      const end = await $.clock.now()
      const shown = (await read($, jobs)).some(j => j.id === id)
      if (shown) await finish($, id, failed)
      else if (!failed) await remember($, histKey, end - start)
      return ran
    } finally {
      t.cancel()
    }
  })

  // ----- the task list: «шаг 3 из 7» -----
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      await update($, plan, steps => {
        if (Array.isArray(e.items)) return e.items.map(s => ({ content: s.content, status: s.status }))
        let out = steps.map(s => ({ ...s }))
        if (e.advance) {
          const i = out.findIndex(s => s.status === 'in_progress')
          if (i >= 0) out[i].status = 'completed'
          const n = out.findIndex(s => s.status === 'pending')
          if (n >= 0) out[n].status = 'in_progress'
        }
        for (const d of e.done ?? []) if (out[d - 1]) out[d - 1].status = 'completed'
        if (e.start && out[e.start - 1]) {
          out = out.map(s => (s.status === 'in_progress' ? { ...s, status: 'pending' as const } : s))
          out[e.start - 1].status = 'in_progress'
        }
        return out
      })
    } catch { /* never fail the call */ }
    return ran
  })
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    try { await update($, plan, () => e.todos.map(t => ({ content: t.activeForm || t.content, status: t.status }))) } catch { /* ignore */ }
    return ran
  })
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    await update($, plan, () => [])
    return next(e)
  })

  // ----- drawing -----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, jobs)
    const steps = await read($, plan)
    const cur = steps.findIndex(s => s.status === 'in_progress')
    const showPlan = steps.length > 1 && cur >= 0
    if (list.length === 0 && !showPlan) return next(e)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.viewport?.columns ?? 100
    return (
      <Box flexDirection="column">
        {showPlan ? (
          <Text dimColor>{`📋 Шаг ${cur + 1} из ${steps.length} · ${steps[cur].content}`}</Text>
        ) : null}
        {list.map(j => {
          const stuck = stalledFor(j, now) > 0 && bySize(j)
          return (
            <Box key={j.id} flexDirection="row">
              <Text color={j.failed || stuck ? 'red' : j.doneAt ? 'green' : undefined}>{line(j, now, width)}</Text>
              {j.note && !j.doneAt ? <Text dimColor>{'  ' + j.note}</Text> : null}
              <Text>{'  '}</Text>
              {j.taskId && !j.doneAt ? (
                <Button
                  key={'stop-' + j.id}
                  label="Остановить"
                  onPress={async () => {
                    try { await $.tool.call({ tool: 'TaskStop', task_id: j.taskId }) } catch { /* already gone */ }
                    await finish($, j.id, true)
                  }}
                />
              ) : null}
              <Button key={'hide-' + j.id} label="Скрыть" onPress={() => update($, jobs, l => l.filter(x => x.id !== j.id))} />
            </Box>
          )
        })}
      </Box>
    )
  })
}
