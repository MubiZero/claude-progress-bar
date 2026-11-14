# progress-bar — a live progress bar for Claude Code

When Claude downloads a big file, builds an app or renders something for minutes, it can look like it is just sitting there. This mod gives Claude a `progress` tool and draws a live bar above the prompt so you always see what is running, how far it got and roughly how long is left — in one short line.

```
⏳ Модель Vosk-TTS ▰▰▰▰▰▰▰▰▱▱▱▱ 72% · 563/783 МБ · 310 КБ/с · ~12 мин
✓ Сборка APK ▰▰▰▰▰▰▰▰▰▰▰▰ готово за 2 мин
```

## Install

In a Claude Code session:

```
/plugin install progress-bar --marketplace MubiZero/claude-progress-bar
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it work in every project).

## What it does

- **Bars for what Claude asks for.** Claude calls `progress` with an `id`, a `title` and either `file` + `total` (a download or any growing file — size, speed and time left are measured every 2 s) or `pct` / `current`+`total` with a `note` for the step.
- **Bars that follow a file by themselves.** `file` + `count` (a regex, e.g. `^## День`) counts the matching lines of a file a long job writes — an agent's report, a log — every 2 s: each new line moves the bar and becomes the step, with `total` it ends at that many. No calls and no tokens while it runs. Between two lines the bar moves on by the mean step so far, and a bar with nothing measured yet shows a block running along it, so live work never looks frozen.
- **Bars for commands by themselves.** A background command gets a bar at once; a `curl -o` / `wget -O` download gets size and speed from the server's Content-Length. A foreground command that runs longer than 15 s gets a bar too. Percent is read from the bracket convention (`[ 45%]`), a bare trailing `NN%`, git's own transfer counters (`Receiving objects: 45%`, `Resolving deltas: …`), and dpkg/apt's `Progress: [...] NN%`; with no percent at all, a step fraction such as docker's `Step 3/8 :`, buildkit's `[stage-1 3/8]` or a plain `task 3 of 8` is converted to one.
- **Time left from past runs.** Durations are kept per kind of job (the last 5, across sessions), so a build that took 4 minutes last time shows “~4 мин” from its first second.
- **Tidy.** One line per bar, the title cut to fit; a background command with nothing to measure (a server, a watcher loop) folds into one dim line «⋯ фоном: …» instead of a bar of its own; steps that move when the work says so are never flagged as silent.
- **Stuck detection.** A download that has not grown for a minute turns red: “застряло 2 мин”; a command silent for 5 minutes says “тихо”.
- **Notification at the end, and along the way.** Work that took over 30 s raises a system notification when it ends (macOS: banner with a sound) — “✓ Готово: …” or “✗ Ошибка: …”. A job still running past 5 minutes also gets a heartbeat notification — the same percent and ETA as the live bar — every 10 minutes after that, so a build you walked away from still reports in instead of going quiet until it finishes.
- **Buttons.** «■» stops a background command, «×» drops a bar.
- **The plan.** While Claude keeps a task list, a line on top shows “📋 Шаг 3 из 7 · <step>”.
- **Pairs with Claude Code's own `terminalProgressBarEnabled`.** That setting puts progress in the terminal's own tab/Dock indicator (OSC 9;4) so it is visible even when this pane isn't focused; this mod's bar is the detailed one-line view when you are looking. Turn it on once: `"terminalProgressBarEnabled": true` in `~/.claude/settings.json`.

Labels are in Russian (МБ, осталось ~N мин); the code is small and easy to translate in `hooks/register.tsx`.

## Develop

```
claude plugin validate .
claude plugin test .
```

MIT licensed.
