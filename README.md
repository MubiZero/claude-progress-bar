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
- **Bars for commands by themselves.** A background command gets a bar at once (its percent is read from output like `[ 45%]`, it ends on the command's exit); a `curl -o` / `wget -O` download gets size and speed from the server's Content-Length. A foreground command that runs longer than 15 s gets a bar too.
- **Time left from past runs.** Durations are kept per kind of job (the last 5, across sessions), so a build that took 4 minutes last time shows “~4 мин” from its first second.
- **Stuck detection.** A download that has not grown for a minute turns red: “застряло 2 мин”; a command silent for 5 minutes says “тихо”.
- **Notification at the end.** Work that took over 30 s raises a system notification (macOS: banner with a sound) — “✓ Готово: …” or “✗ Ошибка: …”.
- **Buttons.** «Остановить» stops a background command, «Скрыть» drops a bar.
- **The plan.** While Claude keeps a task list, a line on top shows “📋 Шаг 3 из 7 · <step>”.

Labels are in Russian (МБ, осталось ~N мин); the code is small and easy to translate in `hooks/register.tsx`.

## Develop

```
claude plugin validate .
claude plugin test .
```

MIT licensed.
