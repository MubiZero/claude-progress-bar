import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'progress-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// Everything beneath the plugin that the mod calls on the engine.
function engine(on: any, opts: { now?: () => number; store?: Map<string, unknown>; tail?: string; ticks?: (() => void)[] } = {}) {
  const store = opts.store ?? new Map<string, unknown>()
  on('tool.register', () => ({ value: { tool: 'mcp__progress-bar__progress' } }))
  // With `ticks`, each period waits for the test to release it (one call = one tick of the mod).
  on('clock.every', () => (opts.ticks ? new Promise(r => opts.ticks!.push(() => r({ value: {} }))) : { value: {} }))
  on('clock.after', () => ({ value: {} }))
  on('clock.now', () => ({ value: opts.now ? opts.now() : 1_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'test' } }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => { store.set(e.key, e.value); return { value: undefined } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: opts.tail ?? '/tmp/claude-1/p/s/tasks/abc.output\n', stderr: '' } }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return store
}

test('a progress call draws a bar above the prompt, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const r = await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'b', title: 'Сборка', pct: 40, note: 'компиляция' })
  expect(String(r.result)).toMatch(/Сборка.*40%/)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /Сборка/ })
    expect(row?.text).toMatch(/40%/)
    expect(await ui.find({ type: 'Button', key: 'hide-b' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hide-b' })
  expect(await ui.find({ type: 'Text', text: /Сборка/ })).toBeUndefined()
  await ui.unmount()
})

test('a call without id is refused', async ($, on) => {
  engine(on)
  const r = await $.tool.call({ tool: 'mcp__progress-bar__progress' } as never)
  expect(r.deny).toMatch(/id/)
})

test('a background command gets a bar with a stop button', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'abc' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'make all', description: 'Собрать проект', run_in_background: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Собрать проект/ }))?.text).toMatch(/⏳/)
  expect(await ui.find({ type: 'Button', key: 'stop-bg-abc' })).toBeDefined()
  await ui.unmount()
})

test('a finished job is remembered and the next one shows time left from the start', async ($, on) => {
  let now = 1_000_000
  const store = engine(on, { now: () => now })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'x', title: 'Рендер' })
  now += 120_000
  await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'x', done: true })
  expect(Array.from(store.values())).toContainEqual([120_000])

  await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'y', title: 'Рендер' })
  now += 30_000
  const r = await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'y', note: 'кадры' })
  expect(String(r.result)).toMatch(/~2 мин|~90 с|~1 мин/)
})

test('the task list shows the current step', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', scope: 'continuation', items: [
    { content: 'Скачать', status: 'in_progress' }, { content: 'Собрать', status: 'pending' }, { content: 'Проверить', status: 'pending' },
  ] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Шаг/ }))?.text).toBe('📋 Шаг 2 из 3 · Собрать')
  await ui.unmount()
})

test('count: the bar counts the matching lines of a file by itself and shows the last as the step', async ($, on) => {
  const ticks: (() => void)[] = []
  engine(on, { tail: '## День 1 (смена)\n## День 2 (склад с нуля)\n', ticks })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'sim', title: 'Симуляция', file: '/tmp/report.md', count: '^## День', total: 7 })
  ticks.shift()?.()
  await new Promise(r => setTimeout(r, 20))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Симуляция/ }))?.text).toMatch(/2\/7/)
  expect((await ui.find({ type: 'Text', text: /День 2 \(склад с нуля\)/ }))).toBeDefined()
  await ui.unmount()
})
