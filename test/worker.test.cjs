"use strict";

const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const {readFileSync} = require("node:fs");
const {mkdtemp, readFile, rm, writeFile} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const {DEFAULT_SETUP, ACTIVITY_ENABLED_KEYS} = require("../src/model.js");
const {readRunFile} = require("../src/run-file.js");

function makeWorker(overrides = {}) {
  const messages = [];
  const context = vm.createContext({
    self: {}, Blob, performance, setTimeout, clearTimeout, Response, ReadableStream,
    TextEncoder, TextDecoder, CompressionStream, DecompressionStream,
    crypto: {getRandomValues: words => words.fill(65743)},
    postMessage: message => messages.push(structuredClone(message)),
    ...overrides,
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(readFileSync(join(__dirname, "../src", file), "utf8"), context, {filename: file});
    }
  };
  context.importScripts("worker.js");
  const worker = {runId: 1, messages};
  worker.send = (type, payload = {}) => {
    messages.length = 0;
    const result = context.self.onmessage({data: {type, runId: worker.runId, ...payload}});
    assert.ok(!messages.some(message => message.type === "failure"));
    return result;
  };
  worker.exportRun = async () => {
    await worker.send("export");
    assert.equal(messages[0].type, "export");
    return JSON.parse(await messages[0].blob.text());
  };
  return worker;
}

function quietStart() {
  const startingGeneSwitches = Object.fromEntries(Object.keys(DEFAULT_SETUP.startingGeneSwitches).map(key => [key, true]));
  const setup = {...DEFAULT_SETUP, radius: 1, founders: 3, startingGeneSwitches};
  const params = {...Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, false])), suddenDeath: 0, persistence: 0};
  return {setup, params, watch: {cell: 0, token: 0}, refresh: 500, speed: 1};
}

test("the worker previews founder switches, merges live resets at the next tick and isolates restarts", async () => {
  const worker = makeWorker();
  const {send, exportRun, messages} = worker;
  const start = quietStart();
  send("reset", start);
  send("gene-switches", {values: {"growth.mass": false}, revision: 1});
  const founders = await exportRun();
  assert.equal(founders.tick, 0);
  assert.equal(founders.setup.startingGeneSwitches["growth.mass"], false);
  assert.equal(founders.history[0].activeConnections, 42);
  assert.deepEqual(founders.geneSwitchChanges, []);
  send("step");
  send("gene-switches", {values: {"growth.mass": true, "movement.energy": false}, revision: 2});
  send("gene-switches", {values: {"movement.energy": true}, revision: 3});
  const pending = await exportRun();
  assert.equal(pending.geneSwitchChanges.length, 0);
  send("step");
  assert.equal(messages.find(message => message.type === "genes-applied").revision, 3);
  const applied = await exportRun();
  assert.deepEqual(applied.geneSwitchChanges, [{tick: 2, values: {"growth.mass": true, "movement.energy": true},
    population: 3, weightsDrawn: 6, weightsRemoved: 0}]);
  for (let i = 0; i < applied.entities.length; i++) {
    assert.notEqual(applied.entities[i].coefficients[14], pending.entities[i].coefficients[14]);
    assert.deepEqual(applied.entities[i].coefficients.slice(0, 4), founders.entities[i].coefficients.slice(0, 4));
  }
  assert.equal(applied.history[2].geneSwitchReset, true);
  assert.equal(applied.history[2].totals.switchFlips, 0);
  send("step");
  assert.equal((await exportRun()).history[3].geneSwitchReset, false);
  send("gene-switches", {values: {"growth.mass": false}, revision: 4});
  worker.runId++;
  const startingGeneSwitches = {...start.setup.startingGeneSwitches, "movement.energy": false};
  send("reset", {...start, setup: {...start.setup, startingGeneSwitches}});
  send("gene-switches", {runId: worker.runId - 1, values: {"movement.energy": true}, revision: 5});
  send("step");
  const restarted = await exportRun();
  assert.equal(restarted.history[1].activeConnections, 42);
  assert.deepEqual(restarted.geneSwitchChanges, []);
  assert.equal(restarted.appliedGeneSwitches["movement.energy"], false);
});

test("a save captures its tick while the worker can keep stepping and restores queued edits", async () => {
  const worker = makeWorker();
  const {send, exportRun, messages} = worker;
  const start = {...quietStart(), speed: 25, refresh: 5000, pauseAtTick: 12};
  send("reset", start);
  send("step");
  send("tune", {values: {foodMean: 3.25}});
  send("gene-switches", {values: {"growth.mass": false}, revision: 1});

  const saving = send("export");
  send("step");
  assert.equal(messages.at(-1).tick, 2);
  await saving;
  const file = messages.find(message => message.type === "export").blob;
  const saved = await readRunFile(file);
  assert.equal(saved.tick, 1);
  assert.equal(saved.history.length, 2);
  assert.equal(saved.parameterChanges.length, 0);
  assert.equal(saved.geneSwitchChanges.length, 0);
  assert.equal(saved.appliedParameters.foodMean, 2);
  assert.equal(saved.appliedGeneSwitches["growth.mass"], true);
  assert.equal(saved.checkpoint.pendingParameters.foodMean, 3.25);
  assert.equal(saved.checkpoint.pendingGeneSwitches["growth.mass"], false);

  await send("import", {file, nextRunId: 2});
  const loaded = messages.find(message => message.type === "imported");
  assert.equal(loaded.tick, 1);
  assert.equal(loaded.params.foodMean, 3.25);
  assert.equal(loaded.setup.startingGeneSwitches["growth.mass"], false);
  assert.deepEqual(loaded.playback, {speed: 25, refresh: 5000, pauseAtTick: 12});
  assert.equal(messages.at(-1).reason, "paused");
  assert.equal(messages.at(-1).runId, 2);
  send("step");
  assert.equal(messages.length, 0);

  worker.runId = 2;
  send("step");
  const resumed = await exportRun();
  assert.equal(resumed.tick, 2);
  assert.deepEqual(resumed.parameterChanges, [{tick: 2, values: {foodMean: 3.25}}]);
  assert.equal(resumed.entities[0].coefficients[5], null);
  assert.equal(resumed.geneSwitchChanges[0].tick, 2);
});

test("file errors leave the current run available to step", async () => {
  const worker = makeWorker({Response: class {
    constructor() { throw new RangeError("Export blocked for this test."); }
  }});
  const {send, messages} = worker;
  send("reset", quietStart());
  send("step");
  await send("export");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "file-error");
  assert.equal(messages[0].operation, "export");
  await send("import", {file: new Blob(['{"model":"Petri Dish","history":[']), nextRunId: 2});
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "file-error");
  assert.equal(messages[0].operation, "import");
  send("step");
  assert.equal(messages.at(-1).reason, "paused");
  assert.equal(messages.at(-1).tick, 2);
});

test("the worker preserves queued SC Cycle settings through founder previews, export and import", async () => {
  const worker = makeWorker();
  const {send, exportRun, messages} = worker;
  send("reset", quietStart());
  send("sc-cycle", {values: {enabled: true, period: 8, searchProportion: 0.25, transitionProportion: 0}});
  send("tune", {values: {foodMean: 3}});
  const saved = await exportRun();
  assert.equal(saved.checkpoint.scCycle.enabled, false);
  assert.equal(saved.checkpoint.pendingScCycle.enabled, true);
  assert.equal(saved.checkpoint.pendingScCycle.period, 8);

  const file = new Blob([JSON.stringify(saved)]);
  await send("import", {file, nextRunId: 2});
  assert.equal(messages.find(message => message.type === "imported").scCycle.period, 8);
  worker.runId = 2;
  send("step");
  assert.equal(messages.find(message => message.type === "frame").scReading.phase, "search");
  assert.equal((await exportRun()).checkpoint.scCycleStartTick, 1);
  send("sc-cycle", {values: {enabled: false}});
  send("step");
  const frame = messages.find(message => message.type === "frame");
  assert.equal(frame.scReading, null);
  assert.equal(frame.scCycle.enabled, false);
});

test("a model preset applies its consolidation settings through the worker's founder preview", async () => {
  const {send, messages, exportRun} = makeWorker();
  send("reset", {...quietStart(), scCycle: {
    period: 10, searchLength: 0, transitionLength: 2, consolidation: {mutationRate: 0},
  }});
  send("tune", {values: {foodMean: 1.5, mutateParent: true}, scCycle: {consolidation: {mutationRate: 0.2}}});
  const before = await exportRun();
  assert.equal(before.checkpoint.pendingScCycle.consolidation.mutationRate, 0.2);
  send("step");
  const frame = messages.find(message => message.type === "frame");
  assert.equal(frame.params.foodMean, 1.5);
  assert.equal(frame.params.mutateParent, true);
  assert.equal(frame.params.mutationRate, 0.2);
  assert.equal(frame.scReading, null);
});

test("a saved preset rebuilds the founder preview and queues live edits after the run begins", async () => {
  const {send, messages, exportRun} = makeWorker();
  const start = quietStart();
  const scCycle = {period: 21, searchLength: 3, transitionLength: 4};
  const playback = {speed: 50, refresh: 500, pauseAtTick: 12};
  const setup = {...start.setup, radius: 2, founders: 5};
  const watch = {cell: 9, token: 1};
  send("reset", start);
  send("sc-cycle", {values: {period: 8, searchLength: 2, transitionLength: 0}});
  send("apply-preset", {setup, params: {...start.params, foodMean: 4}, scCycle, playback, watch});
  const preview = messages.find(message => message.type === "frame");
  assert.equal(preview.watchToken, 1);
  assert.equal(preview.snapshot.cells.length, 19);
  const beforeStart = await exportRun();
  assert.equal(beforeStart.tick, 0);
  assert.equal(beforeStart.entities.length, 5);
  assert.equal(beforeStart.checkpoint.scCycle.period, 21);
  assert.equal(beforeStart.checkpoint.pendingScCycle, null);
  assert.deepEqual(beforeStart.checkpoint.playback, playback);

  send("step");
  send("apply-preset", {params: {...start.params, foodMean: 6}, scCycle: {...scCycle, searchLength: 0}, playback,
    geneSwitches: {"growth.mass": false}, revision: 1});
  const beforeStep = await exportRun();
  assert.equal(beforeStep.tick, 1);
  assert.equal(beforeStep.checkpoint.pendingScCycle.searchLength, 0);
  assert.equal(beforeStep.checkpoint.pendingParameters.foodMean, 6);
  send("step");
  assert.equal(messages.find(message => message.type === "genes-applied").revision, 1);
  const continued = await exportRun();
  assert.deepEqual(continued.history.slice(0, 2), beforeStep.history);
  assert.equal(continued.tick, 2);
  assert.equal(continued.setup.radius, 2);
  assert.equal(continued.appliedParameters.foodMean, 6);
  assert.equal(continued.appliedGeneSwitches["growth.mass"], false);
  assert.equal(continued.checkpoint.scCycle.searchLength, 0);
});

test("a browser checkpoint can advance in Node and return with its full history and queued edits", async t => {
  const folder = await mkdtemp(join(tmpdir(), "petri-round-trip-"));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const run = (...args) => execFileSync(process.execPath, [join(__dirname, "../src/run.cjs"), ...args], {cwd: folder});
  const worker = makeWorker();
  const start = {...quietStart(), pauseAtTick: 2};
  worker.send("reset", start);
  worker.send("step");
  worker.send("tune", {values: {foodMean: 3.25}});
  worker.send("gene-switches", {values: {"growth.mass": false}, revision: 1});
  const browserSave = await worker.exportRun();
  await writeFile(join(folder, "browser.json"), JSON.stringify(browserSave));

  run("--load", "browser.json", "--ticks", "0", "--out", "copy.json.gz");
  const copy = new Blob([await readFile(join(folder, "copy.json.gz"))]);
  assert.deepEqual({...await readRunFile(copy)}, browserSave);
  run("--load", "copy.json.gz", "--ticks", "4", "--out", "continued.json");
  const file = new Blob([await readFile(join(folder, "continued.json"))]);
  const continued = JSON.parse(await file.text());
  assert.equal(continued.tick, 5);
  assert.equal(continued.history.length, 6);
  assert.deepEqual(continued.history.slice(0, 2), browserSave.history);
  assert.deepEqual(continued.parameterChanges, [{tick: 2, values: {foodMean: 3.25}}]);
  assert.deepEqual(continued.geneSwitchChanges.map(change => change.tick), [2]);
  assert.deepEqual(continued.checkpoint.pendingParameters, {});
  assert.deepEqual(continued.checkpoint.pendingGeneSwitches, {});
  assert.deepEqual(continued.checkpoint.playback, browserSave.checkpoint.playback);

  await worker.send("import", {file, nextRunId: 2});
  assert.equal(worker.messages.find(message => message.type === "imported").tick, 5);
  worker.runId = 2;
  assert.deepEqual(await worker.exportRun(), continued);
  worker.send("step");
  assert.equal(worker.messages.at(-1).tick, 6);
});
