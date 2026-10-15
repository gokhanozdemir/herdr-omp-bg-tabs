// Opens an unfocused Herdr tab for long-running OMP bash calls.
// Keep this separate from herdr-omp-agent-state.ts, which Herdr overwrites.
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspaceId = process.env.HERDR_WORKSPACE_ID;
const enabled = process.env.HERDR_ENV === "1" && Boolean(workspaceId);
const logDirectory = path.join(os.tmpdir(), "omp-herdr");
const jobs = new Map();
const thresholdMs = 60_000;

function field(value, ...keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
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
  return String(value ?? `job-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
}


function reportFailure(ctx, error) {
  try {
    ctx.ui?.notify?.(`Herdr log tab unavailable: ${String(error).slice(0, 180)}`, "warning");
  } catch {
    // Logging must never interfere with the OMP tool call.
  }
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

async function openTab(pi, job, ctx) {
  if (job.tabId) return;
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.writeFileSync(job.logFile, job.latest || "Waiting for command output…\n");

  const created = parseResult(
    await run(pi, [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      ctx.cwd,
      "--label",
      job.label,
      "--no-focus",
    ]),
  );
  const tabId = created?.tab?.tab_id;
  const paneId = created?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error("Herdr tab response omitted tab or pane id");
  job.tabId = tabId;

  const quotedLog = `'${job.logFile.replace(/'/g, "'\\''")}'`;
  const viewer = `while :; do clear; cat ${quotedLog}; sleep 1; done`;
  await run(pi, ["pane", "run", paneId, viewer]);
}

function writeSnapshot(job, text) {
  if (text) {
    job.latest = text;
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(job.logFile, text);
  }
}

function finishJob(pi, job, event, ctx) {
  const finalText = textOf(field(event, "content", "output", "partialResult", "result", "text"));
  const details = field(event, "details") ?? {};
  const exitCode = field(event, "exitCode", "exit_code") ?? field(details, "exitCode", "exit_code");
  const jobId = field(details, "jobId", "asyncJobId", "id");
  const stillRunning = details.state === "running" || details.jobState === "running";
  const failed = event?.isError === true || (typeof exitCode === "number" && exitCode !== 0);
  fs.mkdirSync(logDirectory, { recursive: true });
  if (finalText && stillRunning) {
    if (!fs.existsSync(job.logFile)) fs.writeFileSync(job.logFile, "");
    fs.appendFileSync(job.logFile, `\n${finalText}\n`);
  } else if (finalText) {
    writeSnapshot(job, finalText);
  }
  const note = stillRunning
    ? `\n[omp] job still running${jobId ? `; inspect proc://${jobId}` : ""}\n`
    : `\n[omp] ${failed ? "failed" : "finished"} (exit ${exitCode ?? "?"})\n`;
  fs.appendFileSync(job.logFile, note);

  if (job.tabId && !stillRunning) {
    const label = `${failed ? "✗" : "✓"} ${job.label}`.slice(0, 48);
    run(pi, ["tab", "rename", job.tabId, label]).catch((error) => reportFailure(ctx, error));
  }
}

const inputs = new Map();

export default function (pi) {
  if (!enabled) return;

  pi.on("tool_call", (event) => {
    if (event?.toolName !== "bash") return;
    inputs.set(safeId(field(event, "toolCallId", "id")), field(event, "input") ?? {});
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event?.toolName !== "bash") return;
    const id = safeId(field(event, "toolCallId", "id"));
    const input = { ...(field(event, "args", "input") ?? {}), ...(inputs.get(id) ?? {}) };
    inputs.delete(id);
    const command = String(field(input, "command") ?? "bash job");
    const job = {
      logFile: path.join(logDirectory, `${id}.log`),
      latest: "",
      label: `omp: ${command.replace(/\s+/g, " ").slice(0, 34)}`,
      tabId: undefined,
      timer: undefined,
      cleanupTimer: undefined,
    };
    jobs.set(id, job);

    const immediate = input.async === true || input.timeout === 0 || Boolean(String(input.name ?? "").trim());
    const launch = () => {
      openTab(pi, job, ctx).catch((error) => reportFailure(ctx, error));
    };
    if (immediate) launch();
    else job.timer = ctx.setTimeout(launch, thresholdMs);
  });

  pi.on("tool_execution_update", (event) => {
    const job = jobs.get(safeId(field(event, "toolCallId", "id")));
    if (job) writeSnapshot(job, textOf(field(event, "output", "partialResult", "result", "content", "text")));
  });

  pi.on("tool_result", (event, ctx) => {
    if (event?.toolName !== "bash") return;
    const id = safeId(field(event, "toolCallId", "id"));
    const job = jobs.get(id);
    if (!job) return;
    finishJob(pi, job, event, ctx);
    if (job.cleanupTimer) ctx.clearTimer(job.cleanupTimer);
    job.cleanupTimer = ctx.setTimeout(() => jobs.delete(id), 5_000);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const id = safeId(field(event, "toolCallId", "id"));
    const job = jobs.get(id);
    if (!job) return;
    if (job.timer) ctx.clearTimer(job.timer);
    if (!job.latest) writeSnapshot(job, textOf(field(event, "output", "partialResult", "result", "content", "text")));
    if (job.cleanupTimer) ctx.clearTimer(job.cleanupTimer);
    job.cleanupTimer = ctx.setTimeout(() => jobs.delete(id), 5_000);
  });
}
