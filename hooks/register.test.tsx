import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'progress-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('a progress call draws a bar above the prompt, on every surface', async ($, on) => {
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__progress-bar__progress' } }))
  on('clock.every', () => ({ value: {} }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const r = await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'b', title: 'Сборка', pct: 40, note: 'компиляция' })
  expect(String(r.result)).toMatch(/Сборка.*40%/)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /Сборка/ })
    expect(row?.text).toMatch(/40%/)
    await ui.unmount()
  }

  await $.tool.call({ tool: 'mcp__progress-bar__progress', id: 'b', remove: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Сборка/ })).toBeUndefined()
  await ui.unmount()
})

test('a call without id is refused', async ($, on) => {
  const r = await $.tool.call({ tool: 'mcp__progress-bar__progress' } as never)
  expect(r.deny).toMatch(/id/)
})
