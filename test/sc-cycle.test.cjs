"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {
  Simulation, ACTIVITIES, COEFFICIENTS, DEFAULT_PARAMS, DEFAULT_SC_CYCLE, SC_GENETIC_KEYS,
  scCycleSettings, scCycleTiming, scCyclePulse, sausageProfile,
} = require("../src/model.js");

const seed = [77, 88, 99, 101];
const entropy = words => words.fill(8797);
const emptySetup = {radius: 0, founders: 0};

test("Full Extreme is preloaded and inactive, with the documented phase lengths and endpoints", () => {
  const simulation = new Simulation({seed, entropy, setup: emptySetup});
  assert.equal(simulation.scCycle.enabled, false);
  assert.equal(simulation.scCycle.period, 2500);
  assert.deepEqual(scCycleTiming(simulation.scCycle), {search: 675, transition: 125, consolidation: 1575});
  assert.deepEqual(SC_GENETIC_KEYS.map(key => simulation.scCycle.search[key]), [0.32, 0, 1, 1, 1.5]);
  assert.deepEqual(SC_GENETIC_KEYS.map(key => simulation.scCycle.consolidation[key]), [0.01, 0, 0.15, 16, 4]);
  assert.equal(simulation.step().scCycle, undefined);
  assert.equal(simulation.exportResults().checkpoint.format, 1);
});

test("the shared pulse samples stable phases, smooth transitions and abrupt switches", () => {
  const settings = scCycleSettings({period: 20, searchProportion: 0.25, transitionProportion: 0.4});
  const phases = [
    ["search", [0, 0, 0]], ["to-consolidation", [0, 5 / 32, 0.5, 27 / 32]],
    ["consolidation", Array(9).fill(1)], ["to-search", [1, 27 / 32, 0.5, 5 / 32]], ["search", [0]],
  ];
  let elapsed = 0;
  for (const [phase, weights] of phases) for (const consolidationWeight of weights) {
    assert.deepEqual(scCyclePulse(settings, elapsed++), {phase, consolidationWeight});
  }
  const weights = cycle => Array.from({length: 5}, (_, tick) => scCyclePulse(cycle, tick).consolidationWeight);
  const abrupt = scCycleSettings({period: 4, searchProportion: 0.25, transitionProportion: 0});
  assert.deepEqual(weights(abrupt), [0, 1, 1, 1, 0]);
  for (const searchProportion of [0, 1]) {
    assert.deepEqual(weights({...abrupt, searchProportion}), Array(5).fill(1 - searchProportion));
  }
  assert.deepEqual(weights({...abrupt, transitionProportion: 1}), [0, 0.5, 1, 0.5, 0]);
});

test("tick lengths are absolute, and transitions use the total across both directions", () => {
  const settings = scCycleSettings({period: 21, searchLength: 3, transitionLength: 9});
  assert.deepEqual(scCycleTiming(settings), {search: 3, transition: 4.5, consolidation: 9});
  const phases = Array.from({length: 21}, (_, tick) => scCyclePulse(settings, tick).phase);
  assert.deepEqual(phases, [
    ...Array(3).fill("search"), ...Array(5).fill("to-consolidation"),
    ...Array(9).fill("consolidation"), ...Array(4).fill("to-search"),
  ]);
  assert.deepEqual(scCycleTiming(scCycleSettings({period: 30}, settings)), {search: 3, transition: 4.5, consolidation: 18});
  assert.throws(() => scCycleSettings({period: 11}, settings), /fit within the period/);
  assert.throws(() => scCycleSettings({searchLength: 2.5}, settings), /whole ticks/);
});

test("zero search length uses consolidation, including after queued changes and a checkpoint reload", () => {
  const simulation = new Simulation({
    seed, entropy, setup: emptySetup,
    scCycle: {period: 12, searchLength: 0, transitionLength: 4, search: {mutationRate: 0.7}, consolidation: {mutationRate: 0}},
  });
  assert.deepEqual(scCycleTiming(simulation.scCycle), {search: 0, transition: 0, consolidation: 12});
  assert.equal(scCyclePulse(simulation.scCycle, 0).phase, "consolidation");
  assert.equal(simulation.step().scCycle, undefined);
  assert.equal(simulation.params.mutationRate, 0);

  simulation.queueScCycle({searchLength: 4});
  assert.equal(simulation.step().scCycle.parameters.mutationRate, 0.7);
  simulation.queueScCycle({searchLength: 0, consolidation: {mutationRate: 0.25}});
  const restored = Simulation.fromResults(JSON.parse(JSON.stringify(simulation.exportResults())), {entropy});
  assert.deepEqual(restored.step(), simulation.step());
  assert.equal(restored.scCycle.transitionLength, 4);
  assert.equal(restored.scCycle.search.mutationRate, 0.7);
  assert.equal(restored.params.mutationRate, 0.25);
  assert.deepEqual(restored.parameterChanges.at(-1), {tick: 3, values: {mutationRate: 0.25}});
  restored.queueParameters({mutationRate: 0.1});
  restored.step();
  assert.equal(restored.scCycle.consolidation.mutationRate, 0.1);
  assert.equal(restored.params.mutationRate, 0.1);
});

test("SC Cycle changes the copying mechanism while ordinary persistence and failed attempts still apply", () => {
  const options = {
    setup: {radius: 0, founders: 1, initialEnergy: 10},
    params: {foodMean: 0, suddenDeath: 0, persistence: 0.05, failedAttemptFraction: 0.6, connectionCost: 0.05, movementCost: 0.1},
    seed, entropy,
  };
  const search = {mutationRate: 1, switchMutationRate: 1};
  const consolidation = {mutationRate: 0, switchMutationRate: 0};
  const cycle = scCycleSettings({enabled: true, period: 2, searchProportion: 0.5, transitionProportion: 0, search, consolidation});
  const simulation = new Simulation({...options, scCycle: cycle});
  const control = new Simulation(options);
  for (const [phase, parameters] of [["search", cycle.search], ["consolidation", cycle.consolidation]]) {
    for (const dish of [simulation, control]) {
      dish.entities.forEach((entity, index) => {
        const action = index === 0 ? "Reproduction" : "Movement";
        ACTIVITIES.forEach((name, i) => { entity.genes[i * COEFFICIENTS.length] = name === action ? 500 : -500; });
      });
    }
    control.queueParameters(parameters);
    const {scCycle, ...actual} = simulation.step();
    assert.equal(scCycle.phase, phase);
    assert.deepEqual(scCycle.parameters, parameters);
    assert.deepEqual(actual, control.step());
    assert.deepEqual(simulation.entities, control.entities);
    assert.equal(actual.births, 1);
    assert.equal(actual.mutations, phase === "search" ? ACTIVITIES.length : 0);
    if (phase === "consolidation") {
      const movement = actual.activities[ACTIVITIES.indexOf("Movement")];
      assert.deepEqual(movement, {selected: 1, attempted: 1, succeeded: 0});
    }
  }
  assert.equal(simulation.params.mutationRate, DEFAULT_PARAMS.mutationRate);
});

test("live edits merge at the next tick, retain phase and survive checkpoint reload", () => {
  const simulation = new Simulation({seed, entropy, setup: emptySetup});
  simulation.step();
  simulation.queueScCycle({enabled: true, period: 20, searchProportion: 0.25, transitionProportion: 0.4});
  simulation.queueScCycle({search: {mutationRate: 0.2}});
  assert.equal(simulation.scCycle.enabled, false);
  assert.equal(simulation.step().scCycle.elapsed, 0);
  assert.equal(simulation.scCycleStartTick, 2);
  assert.equal(simulation.scCycle.search.mutationRate, 0.2);
  for (let tick = 0; tick < 4; tick++) simulation.step();
  simulation.queueScCycle({consolidation: {mutationRate: 0.2}});
  const save = JSON.parse(JSON.stringify(simulation.exportResults()));
  const restored = Simulation.fromResults(save, {entropy});
  assert.deepEqual(restored.scReading, simulation.scReading);
  for (let tick = 0; tick < 20; tick++) {
    const reading = simulation.step();
    assert.equal(reading.scCycle.parameters.mutationRate, 0.2);
    assert.deepEqual(restored.step(), reading);
  }
  assert.deepEqual(restored.exportResults(), simulation.exportResults());
  restored.queueScCycle({enabled: false});
  assert.equal(restored.step().scCycle, undefined);
  restored.queueScCycle({enabled: true});
  assert.equal(restored.step().scCycle.elapsed, 0);
});

test("older seasoning checkpoints retain their genetic pulse with ordinary economic settings", () => {
  const simulation = new Simulation({seed, entropy, setup: emptySetup, params: {persistence: 0.13}});
  simulation.step();
  const saved = JSON.parse(JSON.stringify(simulation.exportResults()));
  delete saved.checkpoint.scCycle;
  Object.assign(saved.checkpoint, {
    format: 2,
    seasoning: {
      period: 10, searchProportion: 0.5, transitionProportion: 0,
      search: {mutationRate: 0.25, persistence: 0.01},
      consolidation: {failedAttemptFraction: 0.8},
    },
  });
  const restored = Simulation.fromResults(saved, {entropy});
  assert.equal(restored.scCycleStartTick, 1);
  assert.equal(restored.scCycle.consolidation.mutationRate, DEFAULT_PARAMS.mutationRate);
  assert.equal(restored.step().scCycle.parameters.mutationRate, 0.25);
  assert.equal(restored.params.persistence, 0.13);
});

test("the plotted sausage profile matches the sampling density and endpoints reject economic edits", () => {
  const search = DEFAULT_SC_CYCLE.search;
  assert.equal(sausageProfile(0, search), 1);
  assert.equal(sausageProfile(1, search), sausageProfile(-1, search));
  assert.ok(Math.abs(sausageProfile(1, search) - 2 ** -1.5) < 1e-15);
  assert.ok(sausageProfile(3, search) > sausageProfile(3, DEFAULT_SC_CYCLE.consolidation));
  assert.throws(() => scCycleSettings({period: 0}), /whole-tick period/);
  assert.throws(() => scCycleSettings({transitionProportion: 1.1}), /proportions/);
  assert.throws(() => scCycleSettings({search: {persistence: 0.01}}), /five inheritance parameters/);
  assert.throws(() => scCycleSettings({search: {mutationTail: 1}}), /out of range/);
});
