"use strict";

const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const {DEFAULT_SETUP, ACTIVITY_ENABLED_KEYS} = require("../src/model.js");

test("the worker previews founder switches, merges live resets at the next tick and isolates restarts", async () => {
  let messages = [];
  const context = vm.createContext({
    self: {}, Blob, performance, setTimeout, clearTimeout,
    crypto: {getRandomValues: words => words.fill(65743)},
    postMessage: message => messages.push(structuredClone(message)),
  });
  for (const file of ["model.js", "worker.js"]) {
    vm.runInContext(readFileSync(join(__dirname, "../src", file), "utf8"), context);
  }
  let runId = 1;
  function send(type, payload = {}) {
    messages = [];
    context.self.onmessage({data: {type, runId, ...payload}});
    assert.ok(!messages.some(message => message.type === "failure"));
  }
  async function exportRun() {
    send("export");
    return JSON.parse(await messages[0].blob.text());
  }
  const setup = {...DEFAULT_SETUP, radius: 1, founders: 3};
  const params = {...Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, false])), suddenDeath: 0, persistence: 0};
  const start = {setup, params, watch: {cell: 0, token: 0}, refresh: 500, speed: 1};
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
  runId++;
  send("reset", {...start, setup: {...setup, startingGeneSwitches: {"movement.energy": false}}});
  send("gene-switches", {runId: runId - 1, values: {"movement.energy": true}, revision: 5});
  send("step");
  const restarted = await exportRun();
  assert.equal(restarted.history[1].activeConnections, 42);
  assert.deepEqual(restarted.geneSwitchChanges, []);
  assert.equal(restarted.appliedGeneSwitches["movement.energy"], false);
});
