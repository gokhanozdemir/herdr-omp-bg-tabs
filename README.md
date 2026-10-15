# Herdr tabs for OMP background bash jobs

An OMP extension that opens an unfocused Herdr tab for long-running bash tool calls and displays the output snapshots OMP emits while the command runs.

## Requirements

- OMP with JS/TS extension support and `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, and `tool_result` events.
- Herdr installed and on `PATH`.
- OMP running in a Herdr-managed pane with `HERDR_ENV=1` and `HERDR_WORKSPACE_ID` set. The extension uses the current workspace; it does not set or change environment variables.

## Install

Copy `herdr-bg-tabs.ts` into OMP's extension directory:

```sh
mkdir -p ~/.omp/agent/extensions
cp herdr-bg-tabs.ts ~/.omp/agent/extensions/
```

Start a new OMP session in Herdr to load the extension. It is separate from `herdr-omp-agent-state.ts`, which Herdr manages and may overwrite.

## Behavior

- `bash` calls with `async: true`, `timeout: 0`, or a named service request a tab immediately.
- Other `bash` calls request a tab after 60 seconds; short calls do not open one.
- Tabs are created in the agent's current Herdr workspace, use the active session directory, and do not take focus away from the agent tab.
- The tab refreshes from tool output snapshots OMP sends. Completed calls are marked in the tab name. For results that report a running async job, the log includes a `proc://` reference when OMP supplies its identifier.
- The extension does not rewrite commands, poll OMP's internal job manager, or claim continuous output after OMP stops emitting updates for an async job. In that case the tab shows the last received snapshot and the `proc://` reference; inspect that job through OMP.
- Only the `bash` tool is monitored. Other OMP background work, including subagents, is not surfaced.

The extension is a local convenience, not a persistence or job-supervision mechanism. Temporary logs are written under the operating system's temp directory in `omp-herdr/`.

No license file is included. Public visibility alone does not grant reuse rights.
