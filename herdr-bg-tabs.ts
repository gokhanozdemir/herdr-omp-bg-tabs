// Streams long-running OMP bash output, line by line, into unfocused Herdr panes.
// Jobs of one agent share a tab as a grid (default 2x2); a full tab starts the next one.
// Keep this separate from herdr-omp-agent-state.ts, which Herdr overwrites.
//
// Safety: the agent's bash call always wins. Only observer events are used
// (`tool_call` errors would block the call; `tool_result` sits in result
// dispatch), every handler swallows its own errors, and Herdr I/O is
// fire-and-forget.
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspaceId = process.env.HERDR_WORKSPACE_ID;
const enabled = process.env.HERDR_ENV === "1" && Boolean(workspaceId);
const logDirectory = path.join(os.tmpdir(), "omp-herdr");
const thresholdMs = delayFromEnv();
const gridSetting = gridFromEnv();
const jobs = new Map();
// Agent id -> the tab currently being filled for that agent.
const groups = new Map();
const reported = new Set();
// Serializes tab/pane placement so concurrent jobs cannot claim the same grid cell.
let placementQueue = Promise.resolve();

// Smallest pane worth splitting into, in terminal cells.
const MIN_PANE_COLS = 40;
const MIN_PANE_ROWS = 8;
const LABEL_CHARS = 48;
// Shorter overlaps are treated as coincidence, not continuation.
const MIN_OVERLAP_CHARS = 16;
// OutputSink head-retain marker between the kept head and the rolling tail.
const MIDDLE_ELISION = /\[…\d+(?:ln|B) elided…\]\n?/;
const EXIT_LINE = /Command exited with code (\d+)/;

function delayFromEnv() {
  const raw = process.env.OMP_HERDR_TAB_DELAY_MS;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

/** `CxR` (also `C*R`) caps the grid; `auto` fills whatever the screen fits. */
function gridFromEnv() {
  const raw = String(process.env.OMP_HERDR_TAB_GRID ?? "").trim().toLowerCase();
  if (raw === "auto") return { cols: Infinity, rows: Infinity };
  const match = /^(\d+)\s*[x*×]\s*(\d+)$/.exec(raw);
  const cols = match ? Number(match[1]) : 0;
  const rows = match ? Number(match[2]) : 0;
  return cols > 0 && rows > 0 ? { cols, rows } : { cols: 2, rows: 2 };
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return textOf(value.content);
  }
  return "";
}

function safeId(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function reportFailure(ctx, error) {
  try {
    const message = String(error?.message ?? error).slice(0, 180);
    if (reported.has(message)) return;
    reported.add(message);
    ctx?.ui?.notify?.(`Herdr log pane unavailable: ${message}`, "warning");
  } catch {
    // Reporting must never interfere with the OMP tool call.
  }
}

/** Wraps an event handler so it can never throw into OMP and never returns a result. */
function observe(handler) {
  return (event, ctx) => {
    try {
      handler(event, ctx);
    } catch (error) {
      reportFailure(ctx, error);
    }
  };
}

async function run(pi, args) {
  const result = await pi.exec("herdr", args);
  if (result?.code !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || `herdr exited ${result?.code}`));
  }
  return String(result.stdout ?? "");
}

function parseResult(output) {
  const jsonLine = output
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("{"));
  if (!jsonLine) throw new Error("Herdr returned no JSON response");
  return JSON.parse(jsonLine).result;
}

/** Text after OutputSink's head-retain marker; the rolling tail is what advances. */
function rollingTail(text) {
  const elision = MIDDLE_ELISION.exec(text);
  return elision ? text.slice(elision.index + elision[0].length) : text;
}

let prefixTable = new Int32Array(0);

/** Longest k where `previous` ends with the first k chars of `next` (KMP prefix function, linear). */
function overlapLength(previous, next) {
  const limit = Math.min(previous.length, next.length);
  const text = `${next.slice(0, limit)}\u0000${previous.slice(previous.length - limit)}`;
  if (prefixTable.length < text.length) prefixTable = new Int32Array(text.length);
  prefixTable[0] = 0;
  for (let i = 1; i < text.length; i++) {
    let k = prefixTable[i - 1];
    while (k > 0 && text.charCodeAt(i) !== text.charCodeAt(k)) k = prefixTable[k - 1];
    if (text.charCodeAt(i) === text.charCodeAt(k)) k++;
    prefixTable[i] = k;
  }
  const k = Math.min(prefixTable[text.length - 1], limit);
  // NUL in output can defeat the separator; verify instead of trusting the table.
  return previous.endsWith(next.slice(0, k)) ? k : 0;
}

/**
 * Returns the part of `next` not already covered by `previous`.
 * OMP updates are rolling previews (optionally head + elision marker + tail),
 * not deltas: the next tail is the previous tail minus a dropped prefix plus new text.
 * Uses the longest overlap, so lines are never re-emitted.
 */
function unseenText(previous, next) {
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  const previousTail = rollingTail(previous);
  const nextTail = rollingTail(next);
  const overlap = overlapLength(previousTail, nextTail);
  if (overlap >= Math.min(MIN_OVERLAP_CHARS, previousTail.length)) return nextTail.slice(overlap);
  return `\n[omp] … output skipped …\n${nextTail}`;
}

function appendLog(job, text) {
  if (!job.headerWritten) {
    fs.mkdirSync(logDirectory, { recursive: true });
    const intent = job.intent ? `[omp] ${job.intent}\n` : "";
    text = `${intent}[omp] $ ${job.command}\n${text}`;
    job.headerWritten = true;
  }
  if (text) fs.appendFileSync(job.logFile, text);
}

function appendSnapshot(job, text) {
  if (!text) return;
  const unseen = unseenText(job.seen, text);
  job.seen = text;
  if (unseen) appendLog(job, unseen);
}

function quoteForShell(value) {
  // Single quotes with '\'' escapes parse the same in sh, bash, zsh and fish.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Tab label from the dispatching agent: subagent id, else the session name. */
function tabLabel(pi, ctx, number) {
  const subagent = ctx?.agent?.kind === "sub" ? ctx.agent.id : undefined;
  const session = ctx?.sessionManager?.getSessionName?.() ?? pi.getSessionName?.();
  const owner = oneLine(subagent || session) || path.basename(ctx?.cwd ?? "") || "jobs";
  const suffix = number > 1 ? ` #${number}` : "";
  return `omp: ${owner.slice(0, LABEL_CHARS - 5 - suffix.length)}${suffix}`;
}

/** Grid for a new tab: the configured cap, shrunk to what the agent's tab area fits. */
async function gridForScreen(pi) {
  let { cols, rows } = gridSetting;
  try {
    const area = parseResult(await run(pi, ["pane", "layout", "--current"]))?.layout?.area;
    if (area?.width > 0 && area?.height > 0) {
      cols = Math.min(cols, Math.max(1, Math.floor(area.width / MIN_PANE_COLS)));
      rows = Math.min(rows, Math.max(1, Math.floor(area.height / MIN_PANE_ROWS)));
    }
  } catch {
    // Size unknown: keep the configured grid.
  }
  return { cols: Number.isFinite(cols) ? cols : 2, rows: Number.isFinite(rows) ? rows : 2 };
}

/**
 * Splits the next grid cell off an existing pane. Columns fill first, then rows;
 * each split keeps the share that leaves equal cells once the grid is full.
 */
async function splitIntoGroup(pi, group, cwd) {
  const { panes, cols, rows } = group;
  const index = panes.length;
  const [target, direction, keep] =
    index < cols
      ? [panes[index - 1], "right", 1 / (cols - index + 1)]
      : [panes[index - cols], "down", 1 / (rows - Math.floor(index / cols) + 1)];
  const split = parseResult(
    await run(pi, [
      "pane",
      "split",
      target,
      "--direction",
      direction,
      "--ratio",
      keep.toFixed(4),
      "--cwd",
      cwd,
      "--no-focus",
    ]),
  );
  const paneId = split?.pane?.pane_id;
  if (!paneId) throw new Error("Herdr split response omitted pane id");
  return paneId;
}

async function placePane(pi, job, ctx) {
  const key = ctx?.agent?.id ?? "main";
  const group = groups.get(key);
  if (group && group.panes.length < group.cols * group.rows) {
    try {
      const paneId = await splitIntoGroup(pi, group, job.cwd);
      group.panes.push(paneId);
      return paneId;
    } catch {
      // The user closed that tab or pane: continue in a fresh tab.
    }
  }
  const { cols, rows } = await gridForScreen(pi);
  const number = (group?.number ?? 0) + 1;
  const created = parseResult(
    await run(pi, [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      job.cwd,
      "--label",
      tabLabel(pi, ctx, number),
      "--no-focus",
    ]),
  );
  const paneId = created?.root_pane?.pane_id;
  if (!created?.tab?.tab_id || !paneId) throw new Error("Herdr tab response omitted tab or pane id");
  groups.set(key, { panes: [paneId], cols, rows, number });
  return paneId;
}

function labelPane(pi, job, ctx) {
  if (!job.paneId) return;
  const mark = job.status === undefined ? "" : job.status === "finished" ? "✓ " : "✗ ";
  if (mark && job.marked) return;
  if (mark) job.marked = true;
  run(pi, ["pane", "rename", job.paneId, `${mark}${job.label}`.slice(0, LABEL_CHARS)]).catch((error) =>
    reportFailure(ctx, error),
  );
}

async function openPane(pi, job, ctx) {
  if (job.paneRequested) return;
  job.paneRequested = true;
  appendLog(job, "");

  const placed = placementQueue.then(() => placePane(pi, job, ctx));
  placementQueue = placed.catch(() => undefined);
  const paneId = await placed;
  job.paneId = paneId;
  labelPane(pi, job, ctx);

  // Let the login shell draw its prompt before typing; proceed anyway on timeout.
  await pi
    .exec("herdr", ["pane", "wait-output", paneId, "--regex", "\\S", "--source", "visible", "--timeout", "5000"])
    .catch(() => undefined);
  // No shell syntax: `tail` behaves identically under any login shell.
  await run(pi, ["pane", "run", paneId, `tail -n +1 -F ${quoteForShell(job.logFile)}`]);
  if (job.status !== undefined) labelPane(pi, job, ctx);
}

function exitCodeOf(details, text) {
  const code = details?.exitCode ?? details?.exit_code;
  if (typeof code === "number") return code;
  const match = EXIT_LINE.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Applies a final (or background-handoff) result to the job. */
function settle(pi, id, job, result, isError, ctx) {
  const text = textOf(result);
  appendSnapshot(job, text);
  const details = result?.details ?? {};
  const state = details.async?.state;

  if (state === "running") {
    if (!job.background) {
      job.background = true;
      const jobId = details.async?.jobId;
      appendLog(job, `\n[omp] continues in background${jobId ? `; inspect proc://${jobId}` : ""}\n`);
    }
    return;
  }

  const exitCode = exitCodeOf(details, text);
  const failed =
    isError === true || state === "failed" || state === "cancelled" || (typeof exitCode === "number" && exitCode !== 0);
  job.status = state === "cancelled" ? "cancelled" : failed ? "failed" : "finished";
  appendLog(job, `\n[omp] ${job.status}${exitCode === undefined ? "" : ` (exit ${exitCode})`}\n`);
  if (job.timer) ctx.clearTimer(job.timer);
  jobs.delete(id);
  labelPane(pi, job, ctx);
}

export default function (pi) {
  if (!enabled) return;

  pi.on(
    "tool_execution_start",
    observe((event, ctx) => {
      if (event?.toolName !== "bash") return;
      const id = safeId(event.toolCallId);
      const input = event.args ?? {};
      const command = String(input.command ?? "bash job");
      const intent = oneLine(event.intent);
      const job = {
        command,
        intent,
        cwd: ctx.cwd,
        logFile: path.join(logDirectory, `${id}.log`),
        // Name chosen by the dispatching agent: its intent, else the service name, else the command.
        label: (intent || oneLine(input.name) || `$ ${oneLine(command)}`).slice(0, LABEL_CHARS - 2),
        seen: "",
        headerWritten: false,
        paneRequested: false,
        paneId: undefined,
        timer: undefined,
        background: false,
        status: undefined,
        marked: false,
      };
      jobs.set(id, job);

      const immediate = input.async === true || input.timeout === 0 || Boolean(oneLine(input.name));
      const launch = () => {
        openPane(pi, job, ctx).catch((error) => reportFailure(ctx, error));
      };
      if (immediate) launch();
      else job.timer = ctx.setTimeout(launch, thresholdMs);
    }),
  );

  pi.on(
    "tool_execution_update",
    observe((event, ctx) => {
      const id = safeId(event?.toolCallId);
      const job = jobs.get(id);
      if (!job) return;
      const partial = event.partialResult;
      const state = partial?.details?.async?.state;
      // Detached frames of a backgrounded job carry its terminal state.
      if (job.background && state && state !== "running") settle(pi, id, job, partial, false, ctx);
      else appendSnapshot(job, textOf(partial));
    }),
  );

  pi.on(
    "tool_execution_end",
    observe((event, ctx) => {
      const id = safeId(event?.toolCallId);
      const job = jobs.get(id);
      if (!job) return;
      settle(pi, id, job, event.result, event.isError, ctx);
    }),
  );
}
