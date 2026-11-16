"use strict";

const {Simulation, DEFAULT_PAUSE_TICK} = Petri;
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
let pending = {};
let watch = {cell: 45, entityId: null, token: 0};

function publish({debug = false, replaceHistory = false} = {}) {
  if (replaceHistory) historyIndex = 0;
  const frame = ++sequence;
  const snapshot = simulation.snapshot(watch.cell, watch.entityId);
  const records = simulation.history.slice(historyIndex);
  historyIndex = simulation.history.length;
  lastFrame = performance.now();
  if (debug) waitingForFrame = frame;
  postMessage({
    type: "frame", runId, frame, debug, replaceHistory, records, snapshot,
    watchToken: watch.token, params: simulation.params, minimumMass: simulation.minMass,
    summary: simulation.history.at(-1),
  });
}

function status(reason) {
  postMessage({type: "status", runId, running, tick: simulation?.tick ?? 0, reason});
}

function stop() {
  clearTimeout(timer);
  timer = null;
  running = false;
  waitingForFrame = 0;
}

function schedule(delay) {
  if (!running || waitingForFrame || timer !== null) return;
  timer = setTimeout(pump, delay);
}

function advance() {
  if (Object.keys(pending).length) {
    simulation.applyParameters(pending);
    pending = {};
    postMessage({type: "applied", runId, params: simulation.params});
  }
  simulation.step();
  if (pauseAtTick > 0 && simulation.tick === pauseAtTick) {
    stop();
    return true;
  }
  return false;
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
    if (refresh === 0 && advanced) publish({debug: true});
    if (refresh > 0 && now - lastFrame >= refresh) publish();
    const untilTick = Math.max(0, nextTick - now);
    const untilView = refresh ? Math.max(0, lastFrame + refresh - now) : Infinity;
    schedule(Math.min(untilTick, untilView));
  } catch (error) {
    reportFailure(error);
  }
}

self.onmessage = ({data}) => {
  try {
    if (data.type === "reset") {
      stop();
      runId = data.runId;
      pauseAtTick = data.pauseAtTick ?? DEFAULT_PAUSE_TICK;
      failure = false;
      pending = {};
      watch = data.watch;
      speed = data.speed;
      refresh = data.refresh;
      simulation = new Simulation({setup: data.setup, params: data.params});
      publish({replaceHistory: true});
      status("ready");
      return;
    }
    if (data.runId !== runId || !simulation) return;
    switch (data.type) {
      case "setup":
        if (!running && !simulation.tick && !failure) {
          watch = data.watch;
          simulation = new Simulation({
            setup: data.setup, params: simulation.params, seed: simulation.globalSeed,
          });
          publish({replaceHistory: true});
        }
        break;
      case "tune":
        if (!running && !simulation.tick && !failure) {
          simulation = new Simulation({
            setup: data.setup ?? simulation.setup, params: {...simulation.params, ...data.values}, seed: simulation.globalSeed,
          });
          publish({replaceHistory: true});
        } else {
          Object.assign(pending, data.values);
        }
        break;
      case "display":
        speed = data.speed;
        refresh = data.refresh;
        if (running) {
          clearTimeout(timer);
          timer = null;
          if (refresh > 0) waitingForFrame = 0;
          nextTick = performance.now();
          lastFrame = nextTick;
          schedule(0);
        }
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
      case "export": {
        const blob = new Blob([JSON.stringify(simulation.exportResults())], {type: "application/json"});
        postMessage({type: "export", blob, tick: simulation.tick, runId});
        break;
      }
    }
  } catch (error) {
    reportFailure(error);
  }
};
