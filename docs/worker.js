"use strict";

// The single-file offline build supplies these scripts before the worker.
if (typeof Petri === "undefined") importScripts("./model.js", "./run-file.js");

const {Simulation, DEFAULT_PAUSE_TICK, CHART_WINDOW, SUCCESS_RATE_AVERAGE_TICKS,
  savedPlayback} = Petri;
const {saveRunFile, readRunFile} = PetriRunFile;
const TICK_RATE_INTERVAL = 750;
let simulation;
let runId = 0;
let sequence = 0;
let historyIndex = 0;
let running = false;
let pauseAtTick = DEFAULT_PAUSE_TICK;
let failure = false;
let timer = null;
let waitingForFrame = 0;
let speed = 0;
let refresh = 500;
let nextTick = 0;
let lastFrame = 0;
let tickRateSample = null;
let geneRevision = null;
let watch = {cell: 45, entityId: null, token: 0};
let fileBusy = false;

function publish({debug = false, replaceHistory = false} = {}) {
  if (replaceHistory) historyIndex = 0;
  const frame = ++sequence;
  const snapshot = simulation.snapshot(watch.cell, watch.entityId);
  const firstRecord = Math.max(historyIndex, simulation.history.length - CHART_WINDOW);
  const records = simulation.history.slice(firstRecord);
  const priorActivityStats = firstRecord > historyIndex
    ? simulation.history.slice(Math.max(0, firstRecord + 1 - SUCCESS_RATE_AVERAGE_TICKS), firstRecord).map(row => row.activities)
    : null;
  const earlierExclusions = [];
  let previous;
  for (let i = historyIndex; i < firstRecord; i++) {
    const {tick, excludedActivities} = simulation.history[i];
    const key = excludedActivities.join(",");
    if (key === previous) continue;
    earlierExclusions.push({tick, excludedActivities});
    previous = key;
  }
  historyIndex = simulation.history.length;
  lastFrame = performance.now();
  if (debug) waitingForFrame = frame;
  postMessage({
    type: "frame", runId, frame, debug, replaceHistory, records, snapshot, earlierExclusions, priorActivityStats,
    watchToken: watch.token, params: simulation.params, minimumMass: simulation.minMass,
    summary: simulation.history.at(-1), scCycle: simulation.scCycle, scReading: simulation.scReading,
  });
}

function status(reason) {
  postMessage({type: "status", runId, running, tick: simulation?.tick ?? 0, reason});
}

function sampleTickRate(now) {
  const tick = simulation.tick;
  if (tickRateSample === null) {
    tickRateSample = {tick, time: now};
    return;
  }
  const elapsed = now - tickRateSample.time;
  if (elapsed < TICK_RATE_INTERVAL) return;
  const ticksPerSecond = 1000 * (tick - tickRateSample.tick) / elapsed;
  tickRateSample = {tick, time: now};
  postMessage({type: "tick-rate", runId, ticksPerSecond});
}

function stop() {
  clearTimeout(timer);
  timer = null;
  running = false;
  waitingForFrame = 0;
  tickRateSample = null;
}

function schedule(delay) {
  if (!running || waitingForFrame || timer !== null) return;
  timer = setTimeout(pump, delay);
}

function advance() {
  simulation.step();
  if (geneRevision !== null) {
    postMessage({type: "genes-applied", runId, revision: geneRevision, change: simulation.geneSwitchChanges.at(-1)});
    geneRevision = null;
  }
  if (pauseAtTick > 0 && simulation.tick === pauseAtTick) {
    stop();
    return true;
  }
  return false;
}

function previewFounders(setup, params, scCycle) {
  const preview = new Simulation({setup, params, seed: simulation.globalSeed, scCycle: scCycle ?? simulation.scCycle});
  if (scCycle === undefined) {
    preview.pendingParameters = simulation.pendingParameters;
    preview.pendingGeneSwitches = simulation.pendingGeneSwitches;
    preview.pendingScCycle = simulation.pendingScCycle;
  }
  simulation = preview;
  publish({replaceHistory: true});
}

function setDisplay(settings) {
  ({speed, refresh} = settings);
  if (!running) return;
  clearTimeout(timer);
  timer = null;
  if (refresh > 0) waitingForFrame = 0;
  nextTick = performance.now();
  lastFrame = nextTick;
  schedule(0);
}

function reportFailure(error) {
  stop();
  failure = true;
  status("error");
  postMessage({type: "failure", runId, message: error.message});
}

function pump() {
  timer = null;
  if (!running || waitingForFrame) return;
  try {
    const begun = performance.now();
    const period = speed ? 1000 / speed : 0;
    let advanced = false;
    let checkpoint = false;
    while (performance.now() >= nextTick) {
      checkpoint = advance();
      advanced = true;
      nextTick = period ? Math.max(nextTick + period, performance.now() - 100) : 0;
      if (checkpoint || refresh === 0 || performance.now() - begun >= 9) break;
    }
    if (checkpoint) {
      publish();
      status("checkpoint");
      return;
    }
    const now = performance.now();
    if (advanced) sampleTickRate(now);
    if (refresh === 0 && advanced) publish({debug: true});
    if (refresh > 0 && now - lastFrame >= refresh) publish();
    const untilTick = Math.max(0, nextTick - now);
    const untilView = refresh ? Math.max(0, lastFrame + refresh - now) : Infinity;
    schedule(Math.min(untilTick, untilView));
  } catch (error) {
    reportFailure(error);
  }
}

async function exportRun(requestRunId) {
  if (failure) throw new Error("There is no completed run to export after a simulation error.");
  const data = simulation.exportResults();
  data.checkpoint.playback = {speed, refresh, pauseAtTick};
  const compress = data.history.length > CHART_WINDOW || data.entities.length > CHART_WINDOW;
  const {blob, gzip} = await saveRunFile(data, compress);
  if (runId === requestRunId) postMessage({type: "export", runId, blob, gzip, tick: data.tick});
}

async function importRun(data) {
  const saved = await readRunFile(data.file);
  if (data.runId !== runId) return;
  const restored = Simulation.fromResults(saved);
  const playback = savedPlayback(saved.checkpoint?.playback) ?? {speed, refresh, pauseAtTick};
  if (data.nextRunId !== runId + 1) throw new Error("Invalid run identifier.");

  // Replace the active simulation only after the entire file has been validated.
  stop();
  simulation = restored;
  runId = data.nextRunId;
  failure = false;
  ({speed, refresh, pauseAtTick} = playback);
  geneRevision = simulation.pendingGeneSwitches ? 0 : null;
  watch = {cell: (simulation.cells.length - 1) / 2, entityId: null, token: 0};
  postMessage({
    type: "imported", runId: data.runId, nextRunId: runId, tick: simulation.tick, watch, playback,
    setup: {...simulation.setup, startingGeneSwitches: {...simulation.appliedGeneSwitches, ...simulation.pendingGeneSwitches}},
    params: {...simulation.params, ...simulation.pendingParameters},
    scCycle: simulation.pendingScCycle ?? simulation.scCycle,
    legacy: !saved.checkpoint,
  });
  publish({replaceHistory: true});
  status("paused");
}

async function handleRunFile(data) {
  if (fileBusy) return;
  fileBusy = true;
  try {
    if (data.type === "export") await exportRun(data.runId);
    else await importRun(data);
  } catch (error) {
    if (data.runId === runId) {
      postMessage({type: "file-error", runId, operation: data.type, message: error.message});
    }
  } finally {
    fileBusy = false;
  }
}

self.onmessage = ({data}) => {
  try {
    if (data.type === "reset") {
      stop();
      runId = data.runId;
      pauseAtTick = data.pauseAtTick ?? DEFAULT_PAUSE_TICK;
      failure = false;
      geneRevision = null;
      watch = data.watch;
      speed = data.speed;
      refresh = data.refresh;
      simulation = new Simulation({setup: data.setup, params: data.params, scCycle: data.scCycle});
      publish({replaceHistory: true});
      status("ready");
      return;
    }
    if (data.runId !== runId || !simulation) return;
    switch (data.type) {
      case "setup":
        if (!running && !simulation.tick && !failure) {
          watch = data.watch;
          previewFounders(data.setup, simulation.params);
        }
        break;
      case "tune":
        if (data.scCycle && !failure) simulation.queueScCycle(data.scCycle);
        if (!running && !simulation.tick && !failure) {
          previewFounders(data.setup ?? simulation.setup, {...simulation.params, ...data.values});
        } else {
          simulation.queueParameters(data.values);
        }
        break;
      case "gene-switches":
        if (!running && !simulation.tick && !failure) {
          const setup = {...simulation.setup, startingGeneSwitches: {...simulation.setup.startingGeneSwitches, ...data.values}};
          previewFounders(setup, simulation.params);
          postMessage({type: "genes-applied", runId, revision: data.revision});
        } else {
          simulation.queueGeneSwitches(data.values);
          geneRevision = data.revision;
        }
        break;
      case "sc-cycle":
        if (!failure) simulation.queueScCycle(data.values);
        break;
      case "apply-preset":
        pauseAtTick = data.playback.pauseAtTick;
        setDisplay(data.playback);
        if (failure) break;
        if (!running && !simulation.tick && data.setup) {
          watch = data.watch;
          geneRevision = null;
          previewFounders(data.setup, data.params, data.scCycle);
        } else {
          simulation.queueParameters(data.params);
          simulation.queueScCycle(data.scCycle);
          if (data.geneSwitches) {
            simulation.queueGeneSwitches(data.geneSwitches);
            geneRevision = data.revision;
          }
        }
        break;
      case "display":
        setDisplay(data);
        break;
      case "pause-at-tick":
        pauseAtTick = data.tick;
        break;
      case "start":
        if (!running && !failure) {
          running = true;
          nextTick = performance.now();
          status("running");
          schedule(0);
        }
        break;
      case "pause":
        if (running) {
          stop();
          publish();
          status("paused");
        }
        break;
      case "step":
        if (!running && !failure) {
          const checkpoint = advance();
          publish();
          status(checkpoint ? "checkpoint" : "paused");
        }
        break;
      case "painted":
        if (waitingForFrame === data.frame) {
          waitingForFrame = 0;
          schedule(Math.max(0, nextTick - performance.now()));
        }
        break;
      case "inspect":
        watch = data.watch;
        postMessage({
          type: "inspector", runId, watchToken: watch.token, tick: simulation.tick,
          inspector: simulation.inspect(watch.cell, watch.entityId),
        });
        break;
      case "export":
      case "import":
        return handleRunFile(data);
    }
  } catch (error) {
    reportFailure(error);
  }
};
