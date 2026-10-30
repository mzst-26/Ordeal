// Runs the chart benchmark in headless Chromium and prints the medians and the pass-line verdicts.
// One command, from the repository root:   npm run bench --prefix benchmarks/charts
// Options (optional):                       --case scatter  --engine echarts  --runs 5
// The steps: build the benchmark page with Vite, serve it on 127.0.0.1, open it in Chromium, call window.benchApi for
// each case and engine, take the median of the runs, judge each number against the pass lines, and write last-run.json.
// This is not run in CI: the timings depend on the machine, so only the generator and the checker are unit tested.
import http from "node:http";
import os from "node:os";
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "playwright";
import { CASE_IDS } from "./cases.js";
import { BRUSH_AREAS } from "./echarts-harness.js";
import { BENCH_SEED } from "./data-gen.js";
import { PASS_LINES, judgeTiming, judgeCheck, summarise } from "./pass-lines.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
// The three engines compared. vega-canvas is the plan's setting; vega-svg is the renderer the site ships today.
const ENGINES = ["vega-canvas", "vega-svg", "echarts"];
// The number of runs per case and engine. The owner's plan asks for at least five; the median is reported.
const DEFAULT_RUNS = 5;
// A single timed run that takes longer than this is stopped and reported as unmeasured, not left to hang the run.
const RUN_TIMEOUT_MS = 60000;
// Hover is timed on the two point-and-cell cases; updates on the selection and the toggle; the legend on the heatmap.
const HOVER_CASES = new Set(["scatter", "heatmap"]);
const UPDATE_CASES = new Set(["selection", "toggle"]);
const LEGEND_CASES = new Set(["heatmap"]);
// Each hover uses a different mark, so no run repeats the last one.
const HOVER_STRIDE = 9973;
const HOVER_FIRST = 1000;
const MIME_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
// The result file, written next to this script so the report can cite it.
const RESULT_FILE = join(HERE, "last-run.json");

/** The command-line options: which case, engine and how many runs. Anything not given means every case or engine. */
function readOptions(argv) {
  const options = { caseId: null, engine: null, runs: DEFAULT_RUNS };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--case") options.caseId = value;
    else if (flag === "--engine") options.engine = value;
    else if (flag === "--runs") options.runs = Number(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (options.caseId && !CASE_IDS.includes(options.caseId)) throw new Error(`Unknown case: ${options.caseId}`);
  if (options.engine && !ENGINES.includes(options.engine)) throw new Error(`Unknown engine: ${options.engine}`);
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a whole number of at least 1");
  return options;
}

/** The median of a list of numbers, or null when the list is empty. */
function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Builds the benchmark page into dist/. Vite's own output is kept quiet; only errors reach the console. */
async function buildBenchPage() {
  await build({ configFile: join(HERE, "vite.config.js"), logLevel: "warn" });
}

/** A static server for dist/, on a free port of 127.0.0.1. Chromium loads ES modules, which need http, not file://. */
async function serveDist() {
  const root = join(HERE, "dist");
  const server = http.createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const file = join(root, path === "/" ? "index.html" : path);
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": MIME_TYPES[extname(file)] || "application/octet-stream" });
    response.end(await readFile(file));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/**
 * Runs one page.evaluate with a time limit. The argument is passed into the page, because the function runs there and
 * cannot see variables from this file. Returns { value }, { timedOut: true } or { error }. A timeout is a result, not
 * a crash, so the run goes on and the case is reported as unmeasured.
 */
async function evaluateWithLimit(page, action, argument, limitMs) {
  let timer = null;
  const limit = new Promise((resolveLimit) => {
    timer = setTimeout(() => resolveLimit({ timedOut: true }), limitMs);
  });
  try {
    return await Promise.race([
      page.evaluate(action, argument).then((value) => ({ value })).catch((error) => ({ error: error.message })),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The runs of one case with one engine: every timed number, its reason if missing, and the checks. */
async function runCombination(browser, url, caseId, engine, runs) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.benchApi), null, { timeout: RUN_TIMEOUT_MS });
  const record = {
    caseId, engine, runs, render: [], longestTaskMs: [], hover: [], update: [], checks: {}, stopReason: "",
    hoverReason: "", updateReason: "",
  };
  record.stopReason = await renderRuns(page, record, caseId, engine, runs);
  if (!record.stopReason && HOVER_CASES.has(caseId)) {
    await hoverRuns(page, record, runs);
  }
  if (!record.stopReason && UPDATE_CASES.has(caseId)) {
    await updateRuns(page, record, caseId, runs);
  }
  if (!record.stopReason && LEGEND_CASES.has(caseId)) {
    await renderOnce(page, record, caseId, engine);
    record.checks.legend = await page.evaluate(() => window.benchApi.checks("legend"));
  }
  record.pageErrors = pageErrors;
  await page.close().catch(() => {});
  return record;
}

/** Draws the case once per run. Returns the reason the runs stopped early, or an empty string when all runs finished. */
async function renderRuns(page, record, caseId, engine, runs) {
  for (let run = 1; run <= runs; run += 1) {
    const outcome = await evaluateWithLimit(page, renderInPage, { caseId, engine }, RUN_TIMEOUT_MS);
    if (outcome.timedOut) {
      return `render run ${run} did not finish within ${RUN_TIMEOUT_MS / 1000} s`;
    }
    if (outcome.error) {
      return `render run ${run} failed: ${outcome.error}`;
    }
    record.render.push(outcome.value.ms);
    record.longestTaskMs.push(outcome.value.longestTaskMs);
  }
  return "";
}

/** Draws the case once, for a check that needs the chart on screen and not a timing. */
async function renderOnce(page, record, caseId, engine) {
  await evaluateWithLimit(page, renderInPage, { caseId, engine }, RUN_TIMEOUT_MS);
}

/** Runs inside the page: draws one case with one engine. Kept as a named function so the page call reads plainly. */
function renderInPage(args) {
  return window.benchApi.render(args.caseId, args.engine);
}

/** Hovers one mark per run and records each response time, or the reason it did not respond. */
async function hoverRuns(page, record, runs) {
  for (let run = 0; run < runs; run += 1) {
    const index = HOVER_FIRST + run * HOVER_STRIDE;
    const outcome = await evaluateWithLimit(page, (markIndex) => window.benchApi.hover(markIndex), index, RUN_TIMEOUT_MS);
    if (outcome.timedOut || outcome.error) {
      record.hoverReason = outcome.timedOut ? "hover did not finish in time" : outcome.error;
      return;
    }
    if (outcome.value.ms === null) {
      record.hoverReason = outcome.value.reason;
      return;
    }
    record.hover.push(outcome.value.ms);
  }
}

/** Runs the update step (toggle or selection) once per run. The selection is checked after its last update. */
async function updateRuns(page, record, caseId, runs) {
  const step = caseId === "selection" ? "selection" : "toggle";
  for (let run = 0; run < runs; run += 1) {
    const outcome = await evaluateWithLimit(page, updateInPage, { step, index: run }, RUN_TIMEOUT_MS);
    if (outcome.timedOut || outcome.error) {
      record.updateReason = outcome.timedOut ? "update did not finish in time" : outcome.error;
      return;
    }
    record.update.push(outcome.value.ms);
  }
  if (step === "selection") {
    const area = BRUSH_AREAS[(runs - 1) % BRUSH_AREAS.length];
    record.checks.selection = await page.evaluate((brushArea) => window.benchApi.checks("selection", brushArea), area);
  }
}

/** Runs inside the page: one update step (toggle or selection), numbered by the run so each run changes the state. */
function updateInPage(args) {
  return window.benchApi.update(args.step, args.index);
}

/**
 * The median only when every requested run produced a number. A run that stopped early (no tooltip, timeout) leaves a
 * median of fewer runs, which is not the number the plan asks for, so it is withheld and the case is unmeasured.
 */
function completeMedian(values, runs) {
  return values.length === runs ? median(values) : null;
}

/** The verdict lines for one record: render, hover, update, legend and selection, each with its pass line. */
function judgeRecord(record) {
  const name = `${record.caseId} ${record.engine}`;
  const verdicts = [
    judgeTiming({
      name: `${name} first render`,
      valueMs: median(record.render),
      lineMs: PASS_LINES.renderMs,
      reason: record.stopReason,
    }),
  ];
  if (HOVER_CASES.has(record.caseId)) {
    verdicts.push(judgeTiming({
      name: `${name} hover`,
      valueMs: completeMedian(record.hover, record.runs),
      lineMs: PASS_LINES.interactionMs,
      reason: record.hoverReason || record.stopReason,
    }));
  }
  if (UPDATE_CASES.has(record.caseId)) {
    verdicts.push(judgeTiming({
      name: `${name} update`,
      valueMs: completeMedian(record.update, record.runs),
      lineMs: PASS_LINES.interactionMs,
      reason: record.updateReason || record.stopReason,
    }));
  }
  if (LEGEND_CASES.has(record.caseId)) {
    const legend = record.checks.legend || {};
    verdicts.push(judgeCheck({ name: `${name} colour legend`, passed: legend.passed ?? null, reason: legend.reason || record.stopReason }));
  }
  if (record.caseId === "selection") {
    const selection = record.checks.selection || {};
    verdicts.push(judgeCheck({ name: `${name} selection highlights`, passed: selection.passed ?? null, reason: selection.reason || record.stopReason }));
  }
  if (record.caseId === "facets") {
    verdicts.push(judgeCheck({
      name: `${name} facets aligned`,
      passed: null,
      reason: "not measured: alignment comes from the spec's shared scales and was not checked in pixels",
    }));
  }
  return verdicts;
}

/** The environment of the run, so the numbers can be read against the machine that made them. */
function environment(browser) {
  const playwrightVersion = require("playwright/package.json").version;
  const echartsVersion = require("echarts/package.json").version;
  return {
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0] ? os.cpus()[0].model : "unknown",
    cpuCores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    chromium: browser.version(),
    playwright: playwrightVersion,
    echarts: echartsVersion,
    seed: BENCH_SEED,
  };
}

/** The table printed at the end: one line per timed value and check, with its verdict. */
function printTable(verdicts) {
  for (const verdict of verdicts) {
    const value = verdict.valueMs === undefined || verdict.valueMs === null ? "" : `${verdict.valueMs.toFixed(1)} ms`;
    const detail = verdict.verdict === "unmeasured" ? `(${verdict.reason})` : "";
    console.log(`${verdict.verdict.padEnd(11)} ${verdict.name.padEnd(48)} ${value.padStart(12)} ${detail}`);
  }
}

/** Runs the whole benchmark and writes last-run.json. */
async function main() {
  const options = readOptions(process.argv.slice(2));
  console.log("Building the benchmark page with Vite.");
  await buildBenchPage();
  const { server, url } = await serveDist();
  const browser = await chromium.launch();
  const records = [];
  try {
    const caseIds = options.caseId ? [options.caseId] : CASE_IDS;
    const engines = options.engine ? [options.engine] : ENGINES;
    for (const caseId of caseIds) {
      for (const engine of engines) {
        console.log(`Running ${caseId} with ${engine} (${options.runs} runs).`);
        records.push(await runCombination(browser, url, caseId, engine, options.runs));
      }
    }
    const env = environment(browser);
    const verdicts = records.flatMap(judgeRecord);
    const output = { environment: env, generatedAt: new Date().toISOString(), records, verdicts, summary: summarise(verdicts) };
    writeFileSync(RESULT_FILE, `${JSON.stringify(output, null, 2)}\n`);
    console.log("");
    printTable(verdicts);
    console.log("");
    console.log(`Summary: ${JSON.stringify(output.summary)}`);
    console.log(`Wrote ${RESULT_FILE}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
