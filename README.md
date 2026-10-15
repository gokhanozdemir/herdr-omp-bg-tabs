# herdr-bg-tabs

OMP extension that opens a background (unfocused) Herdr tab showing live output of long-running OMP `bash` tool calls. Your current tab stays focused; slow builds, test runs, and servers get their own tab you can glance at.

## Requirements

- OMP (oh-my-pi coding agent) with extension discovery enabled (the default).
- `herdr` CLI on `PATH`.
- OMP running inside a Herdr workspace, so Herdr exports `HERDR_ENV=1` and `HERDR_WORKSPACE_ID`.

## Install

Copy the single file into your OMP user extensions directory:

```sh
mkdir -p ~/.omp/agent/extensions
curl -fsSL https://raw.githubusercontent.com/gokhanozdemir/herdr-omp-bg-tabs/main/herdr-bg-tabs.ts \
  -o ~/.omp/agent/extensions/herdr-bg-tabs.ts
```

Or clone and copy/symlink:

```sh
git clone https://github.com/gokhanozdemir/herdr-omp-bg-tabs.git
ln -s "$PWD/herdr-omp-bg-tabs/herdr-bg-tabs.ts" ~/.omp/agent/extensions/herdr-bg-tabs.ts
```

Named profile (`omp --profile <name>`): use `~/.omp/profiles/<name>/agent/extensions/` instead. If `PI_CODING_AGENT_DIR` is set, use `$PI_CODING_AGENT_DIR/extensions/`.

Restart OMP. The extension is discovered automatically — no config entry needed.

Keep the file separate from `herdr-omp-agent-state.ts`; Herdr overwrites that file.

## When it is active

At startup the extension enables itself only if **all** hold:

| Condition | Why |
|---|---|
| `HERDR_ENV=1` | running inside Herdr |
| `HERDR_WORKSPACE_ID` set | target workspace for new tabs |

Otherwise it loads and does nothing. Check from an OMP shell:

```sh
echo "HERDR_ENV=$HERDR_ENV"; [ -n "$HERDR_WORKSPACE_ID" ] && echo workspace set; command -v herdr
```

## What it does

For every OMP `bash` tool call:

1. **Tab timing**
   - Immediately, if the call uses `async: true`, `timeout: 0`, or a `name` (long-lived service).
   - Otherwise after **60 s** if the command is still running. Fast commands never get a tab.
2. **Tab contents** — a new unfocused tab in the current workspace, opened in the session's working directory, labeled `omp: <first 34 chars of command>`. It redraws `$TMPDIR/omp-herdr/<toolCallId>.log` every second.
3. **Completion** — appends `[omp] finished (exit N)` or `[omp] failed (exit N)` and renames the tab with a `✓` or `✗` prefix. If the job continues in the background, the log notes it and points to `proc://<jobId>`.
4. **Errors** — Herdr failures appear as a warning toast (`Herdr log tab unavailable: …`) and never affect the bash call itself.

There is nothing to invoke; usage is just running OMP normally.

## Disable

Pick one:

- **Per extension, persistent** — in `/extensions`, toggle it off; or add to `~/.omp/agent/config.yml`:

  ```yaml
  disabledExtensions:
    - extension-module:herdr-bg-tabs
  ```

  `disabledExtensions` is an array: a project-level `.omp/config.yml` value **replaces** the global list, so repeat any global entries there.
- **Per shell** — start OMP outside Herdr, or with `HERDR_ENV` unset.
- **Per session, all extensions** — `omp --no-extensions`.
- **Uninstall** — delete `~/.omp/agent/extensions/herdr-bg-tabs.ts`.

## Cleanup and privacy

- Tabs are not closed automatically; close them in Herdr when done.
- Log files under `$TMPDIR/omp-herdr/` are not deleted; they contain full command output. Remove with `rm -rf "${TMPDIR:-/tmp}/omp-herdr"`.
- Tab labels include the start of each command — avoid inline secrets in commands.

## Limits

- Only the `bash` tool is monitored; subagents and other background work are not surfaced.
- The tab shows snapshots OMP emits. For async jobs, once OMP stops emitting updates the tab keeps the last snapshot plus the `proc://` reference; inspect the job through OMP.
- A local convenience, not job supervision: commands are never rewritten and OMP's job manager is never polled.

## Troubleshooting

| Symptom | Check |
|---|---|
| No tabs ever | activation conditions above; `/extensions` shows it enabled; `herdr` on `PATH` |
| Tab only for some commands | expected: needs 60 s runtime, or `async`/`timeout: 0`/`name` |
| Warning toast | run `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus` manually to see the Herdr error |
| Tab stays blank | log file is written on first output update; it shows `Waiting for command output…` until then |

## License

No license file is included. Public visibility alone does not grant reuse rights.
