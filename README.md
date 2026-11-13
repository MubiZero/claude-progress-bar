# progress-bar — a live progress bar for Claude Code

When Claude downloads a big file, builds an app or renders something for minutes, it can look like it is just sitting there. This mod gives Claude a `progress` tool and draws a live bar above the prompt (and in the status line) so you always see what is running, how far it got, how fast it goes and roughly how long is left.

```
⏳ Модель Vosk-TTS  ████████████░░░░░░░░░░░░░░░░░░  41% · 322 МБ из 783 МБ · 310 КБ/с · осталось ~25 мин
✓ Сборка APK       ██████████████████████████████  готово за 2 мин
```

## Install

In a Claude Code session:

```
/plugin install progress-bar --marketplace MubiZero/claude-progress-bar
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it work in every project).

## How it works

- Claude calls `progress` with an `id`, a `title` and either:
  - `file` + `total` (bytes) — for downloads and anything that writes a growing file. The mod checks the file size every 2 seconds and works out speed and time left by itself, and marks the bar done when the size reaches `total`;
  - `pct` (0–100) or `current` / `total` — for builds, tests and other steps; Claude calls again with the same `id` as the work moves.
- `note` shows the current step, `done: true` finishes the bar (it stays green for a minute), `remove: true` drops it.
- The tool description asks Claude to start a bar for anything longer than ~30 seconds. You can also ask: “show progress while you wait”.

Labels are in Russian (МБ, осталось ~N мин); the code is small and easy to translate in `hooks/register.tsx`.

## Develop

```
claude plugin validate .
claude plugin test .
```

MIT licensed.
