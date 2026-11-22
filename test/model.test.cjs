"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {
  Simulation, Random, ACTIVITY_ENABLED_KEYS, DEFAULT_SETUP, DEFAULT_PARAMS, feedCell, foodIncome, mutateValue, chooseActivity, circumference,
} = require("../src/model.js");

const approx = (actual, expected) => assert.ok(
  Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
  `${actual} differs from ${expected}`,
);

function deterministicEntropy() {
  let next = 21;
  return words => {
    for (let i = 0; i < words.length; i++) {
      next = (Math.imul(1664525, next) + 1013904223) >>> 0;
      words[i] = next;
    }
    return words;
  };
}

function quiet(params = {}, setup = {}) {
  return new Simulation({
    entropy: deterministicEntropy(),
    setup: {radius: 0, founders: 1, initialEnergy: 5, ...setup},
    params: {foodMean: 0, suddenDeath: 0, persistence: 0, connectionCost: 0, mutationRate: 0, switchMutationRate: 0, ...params},
  });
}

function plan(entity, ...logits) {
  entity.genes.fill(0);
  for (let i = 0; i < 5; i++) entity.genes[i * 4] = logits[i] ?? -500;
}

test("the default dish has 91 hexes and 30 distinct, viable founders", () => {
  const sim = new Simulation({entropy: deterministicEntropy()});
  assert.equal(sim.cells.length, 91);
  assert.equal(sim.cells.filter(cell => cell.neighbors.length === 6).length, 61);
  assert.equal(new Set(sim.entities.map(entity => entity.cell)).size, 30);
  assert.equal(sim.minMass, 0.1);
  assert.equal(sim.history[0].activeConnections, 450);
  assert.equal(sim.history[0].effectiveActiveConnections, 450);
  assert.deepEqual(sim.history[0].connectionOnFractions, Array(15).fill(1));
  for (const entity of sim.entities) {
    approx(entity.surface, 2 * Math.sqrt(Math.PI * 10));
    assert.equal(entity.genes.length, 20);
    assert.ok(entity.genes.every(Number.isFinite));
    assert.deepEqual(sim.inspect(entity.cell, entity.id).entity.connectionSwitches, Array(15).fill(true));
    assert.equal(entity.energy, 40);
  }
});

test("feeding shares by surface and reallocates any capacity-limited shares", () => {
  const entity = headroom => ({surface: 2, mass: 10, energy: 80 - headroom, waste: 0});
  for (const reverse of [false, true]) {
    const small = entity(1);
    const large = entity(10);
    const cell = {food: 10, feeders: reverse ? [large, small] : [small, large]};
    approx(feedCell(cell, {...DEFAULT_PARAMS, intake: 5}, 0.5), 10);
    approx(small.energy, 80);
    approx(large.energy, 79);
    approx(large.waste, 4.5);
    approx(cell.food, 0);
  }
  const cell = {food: 8, feeders: [entity(10), {...entity(10), surface: 4}]};
  feedCell(cell, {...DEFAULT_PARAMS, intake: 5}, 0.5);
  approx(cell.feeders[0].waste / cell.feeders[1].waste, 0.5);
});

test("the nonzero tail of an activity is sampled without rounding the sigmoid", () => {
  assert.equal(chooseActivity(-90, {logUniform: () => -100}), true);
  assert.equal(chooseActivity(-90, {logUniform: () => -80}), false);
  assert.equal(chooseActivity(90, {logUniform: () => -100}), false);
  assert.equal(chooseActivity(90, {logUniform: () => -80}), true);
});

test("sudden death occurs before feeding and releases food only in finalization", () => {
  const sim = quiet({foodMean: 3, foodSD: 0, suddenDeath: 1}, {initialFood: 2});
  const first = sim.step();
  assert.equal(first.suddenDeaths, 1);
  assert.equal(first.foodConsumed, 0);
  assert.equal(first.foodRecycled, 10);
  assert.equal(first.food, 15);
  assert.equal(first.population, 0);
  assert.equal(sim.step().food, 18);
});

test("feeding precedes persistence, which precedes every optional activity", () => {
  const sim = quiet({persistence: 0.5, foodMean: 2, foodSD: 0}, {initialEnergy: 0});
  plan(sim.entities[0], 500, 500, 500, 500, 500);
  const frame = sim.step();
  assert.equal(frame.foodConsumed, 2);
  assert.equal(frame.persistenceDeaths, 1);
  assert.ok(frame.activities.every(activity => activity.selected === 0));
  assert.equal(frame.food, 10);
});

test("moving average lifespan retains the most recent 100 deaths across both causes", () => {
  const allOff = Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, false]));
  const sim = quiet({...allOff, persistence: 0.1}, {radius: 6, founders: 101});
  assert.equal(sim.history[0].meanLifespan, null);
  assert.equal(sim.history[0].lifespanSamples, 0);

  sim.entities[0].energy = 0;
  const first = sim.step();
  assert.equal(first.persistenceDeaths, 1);
  assert.equal(first.meanLifespan, 1);
  assert.equal(first.lifespanSamples, 1);

  for (const entity of sim.entities.slice(1)) entity.energy = 0;
  const full = sim.step();
  assert.equal(full.persistenceDeaths, 99);
  assert.equal(full.lifespanSamples, 100);
  approx(full.meanLifespan, 1.99);

  sim.applyParameters({suddenDeath: 1});
  const rolled = sim.step();
  assert.equal(rolled.suddenDeaths, 1);
  assert.equal(rolled.lifespanSamples, 100);
  approx(rolled.meanLifespan, 2.01);
  assert.equal(sim.step().meanLifespan, rolled.meanLifespan);
});

test("successful division terminates execution and newborns act next tick", () => {
  const sim = quiet();
  const parent = sim.entities[0];
  const original = parent.genes;
  plan(parent, -500, 100, -500, -500, 200);
  const frame = sim.step();
  assert.equal(frame.births, 1);
  assert.deepEqual(frame.activities[1], {selected: 1, attempted: 0, succeeded: 0});
  assert.equal(sim.entities[0], parent);
  assert.equal(parent.genes, original);
  assert.notEqual(sim.entities[1].genes, original);
  assert.equal(sim.entities[1].parentId, parent.id);
  assert.equal(sim.entities[1].generation, 1);
  for (const entity of sim.entities) {
    approx(entity.mass, 4.5);
    approx(entity.energy, 1.5);
  }
  assert.equal(frame.food, 1);
  sim.applyParameters({suddenDeath: 1});
  const deaths = sim.step();
  assert.equal(deaths.suddenDeaths, 2);
  assert.equal(deaths.meanLifespan, 1.5);
});

test("decision readouts average the probabilities used before execution and omit newborns", () => {
  const sim = quiet({foodMean: 2, foodSD: 0, persistence: 0.1}, {radius: 1, founders: 2});
  const [parent, other] = sim.entities;
  const initial = sim.history[0];
  assert.equal(initial.decisionCount, 0);
  assert.deepEqual(initial.meanDecisionProbabilities, [null, null, null, null, null]);
  assert.equal(sim.inspect(parent.cell, parent.id).entity.lastDecisionProbabilities, null);
  plan(parent, -3, 100, -500, -500, 200);
  [parent.genes[1], parent.genes[2], parent.genes[3]] = [0.1, 0.25, 0.5];
  plan(other, -3);

  const result = sim.step();
  const child = sim.entities[2];
  assert.equal(result.population, 3);
  assert.equal(result.decisionCount, 2);
  const recorded = sim.inspect(parent.cell, parent.id).entity.lastDecisionProbabilities;
  approx(recorded[0], 0.5);
  assert.ok(recorded[2] > 0);
  approx(result.meanDecisionProbabilities[0], (0.5 + 1 / (1 + Math.exp(3))) / 2);
  assert.equal(sim.inspect(child.cell, child.id).entity.lastDecisionProbabilities, null);
  assert.equal(sim.exportResults().entities[2].lastDecisionProbabilities, null);
  sim.applyParameters({suddenDeath: 1});
  assert.deepEqual(sim.step().meanDecisionProbabilities, [null, null, null, null, null]);
});

test("activity switches exclude decisions and let the same coefficients resume on a later tick", () => {
  const allOff = Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, false]));
  const sim = quiet({...allOff, growthEnabled: true, foodMean: 1, foodSD: 0}, {initialEnergy: 40});
  const entity = sim.entities[0];
  plan(entity, 500, 500, 500, 500, 500);
  const original = entity.genes.slice();
  const before = sim.step();
  assert.deepEqual(before.meanDecisionProbabilities, [null, 1, null, null, null]);
  assert.equal(before.activities[1].succeeded, 1);
  assert.equal(entity.mass, 11);

  sim.applyParameters(allOff);
  const excluded = sim.step();
  assert.deepEqual(excluded.meanDecisionProbabilities, [null, null, null, null, null]);
  assert.deepEqual(before.meanDecisionProbabilities, [null, 1, null, null, null]);
  assert.equal(excluded.decisionCount, 0);
  assert.equal(excluded.foodConsumed, 1);
  assert.equal(excluded.births, 0);
  assert.ok(excluded.activities.every(({selected, attempted, succeeded}) => selected + attempted + succeeded === 0));
  assert.equal(sim.inspect(entity.cell, entity.id).entity.lastDecisionProbabilities, null);
  assert.deepEqual(entity.genes, original);
  assert.equal(entity.mass, 11);

  sim.applyParameters({growthEnabled: true});
  const resumed = sim.step();
  assert.equal(resumed.decisionCount, 1);
  assert.equal(resumed.activities[1].succeeded, 1);
  assert.deepEqual(sim.inspect(entity.cell, entity.id).entity.lastDecisionProbabilities, [null, 1, null, null, null]);
  assert.deepEqual(entity.genes, original);
  approx(entity.mass, 12.1);
  assert.deepEqual(sim.exportResults().parameterChanges, [
    {tick: 2, values: {growthEnabled: false}},
    {tick: 3, values: {growthEnabled: true}},
  ]);
});

test("infeasible division spends nothing and later choices still execute", () => {
  const sim = quiet({}, {initialEnergy: 0.2});
  const parent = sim.entities[0];
  plan(parent, -500, -500, 100, 90, 200);
  const frame = sim.step();
  assert.equal(frame.births, 0);
  assert.equal(frame.foodRecycled, 0);
  assert.equal(frame.activities[4].attempted, 1);
  assert.equal(frame.activities[4].succeeded, 0);
  assert.equal(frame.activities[2].succeeded, 1);
  assert.equal(frame.activities[3].succeeded, 0);
  approx(parent.mass, 9);
  approx(parent.energy, 1.2);
});

test("growth and shrinking use execution-time mass and enforce the fixed minimum", () => {
  const sim = quiet();
  const entity = sim.entities[0];
  plan(entity, -500, 200, 100);
  sim.step();
  approx(entity.mass, 9.9);
  approx(entity.energy, 4.9);
  approx(entity.waste, 0.55);
  approx(entity.surface, circumference(9.9));
  entity.mass = 0.15;
  sim.applyParameters({offspringShare: 0.5, shrinkFraction: 0.5, reproductionCost: 0});
  plan(entity, -500, -500, 100, -500, 200);
  const frame = sim.step();
  assert.equal(frame.births, 0);
  assert.equal(frame.activities[2].succeeded, 0);
  assert.equal(entity.mass, 0.15);
});

test("asymmetric division applies one shared fraction to mass, energy and waste", () => {
  const sim = quiet({offspringShare: 0.25}, {initialWaste: 4});
  plan(sim.entities[0], -500, -500, -500, -500, 500);
  sim.step();
  const [parent, child] = sim.entities;
  assert.deepEqual([child.mass, child.energy, child.waste], [2.25, 0.75, 1]);
  assert.deepEqual([parent.mass, parent.energy, parent.waste], [6.75, 2.25, 3]);
});

test("a capacity change preserves existing stocks and blocks more intake", () => {
  const sim = quiet({foodMean: 2, foodSD: 0});
  const entity = sim.entities[0];
  plan(entity);
  sim.applyParameters({energyCapacity: 0.2, wasteCapacity: 0});
  const frame = sim.step();
  assert.equal(entity.energy, 5);
  assert.equal(frame.energyCapacity, 2);
  assert.equal(frame.foodConsumed, 0);
  assert.deepEqual(sim.parameterChanges, [{tick: 1, values: {energyCapacity: 0.2, wasteCapacity: 0}}]);
});

test("Gamma income and relative mutations reproduce the specified statistical behavior", () => {
  const rng = new Random();
  rng.reseed([19, 6, 3, 6], [1, 2, 3, 4]);
  const n = 40000;
  let sum = 0;
  let sum2 = 0;
  let negativeChange = 0;
  let reversed = 0;
  for (let i = 0; i < n; i++) {
    const food = foodIncome(3, 1.5, rng);
    assert.ok(food >= 0);
    sum += food;
    sum2 += food * food;
    const mutated = mutateValue(1, DEFAULT_PARAMS, rng);
    if (mutated < 1) negativeChange++;
    if (mutated < 0) reversed++;
  }
  assert.ok(Math.abs(sum / n - 3) < 0.04);
  assert.ok(Math.abs(Math.sqrt(sum2 / n - (sum / n) ** 2) - 1.5) < 0.04);
  assert.ok(negativeChange > 0.48 * n && negativeChange < 0.52 * n);
  assert.ok(reversed > 0.004 * n && reversed < 0.03 * n);
  assert.equal(mutateValue(0, DEFAULT_PARAMS, rng), 0);
  assert.equal(foodIncome(0, 10, rng), 0);
});

test("optional parent mutation uses two independent copies of the original pattern", () => {
  const sim = quiet({mutateParent: true, mutationRate: 1});
  const parent = sim.entities[0];
  const original = parent.genes;
  plan(parent, -500, -500, -500, -500, 500);
  const frame = sim.step();
  assert.equal(frame.births, 1);
  const child = sim.entities[1];
  assert.notDeepEqual(parent.genes, original);
  assert.notDeepEqual(child.genes, original);
  assert.notDeepEqual(child.genes, parent.genes);
  assert.equal(frame.mutations, 10);
});

test("disabled coefficients pass intact to parent and offspring during mutation", () => {
  const sim = quiet({growthEnabled: false, movementEnabled: false, mutateParent: true, mutationRate: 1});
  const parent = sim.entities[0];
  plan(parent, -500, 500, -500, 500, 800);
  for (let i = 0; i < parent.genes.length; i++) {
    if (i % 4 !== 0) parent.genes[i] = (i + 1) * 0.001;
  }
  const original = parent.genes.slice();
  const frame = sim.step();
  assert.equal(frame.births, 1);
  assert.equal(frame.mutations, 24);
  for (const entity of sim.entities) {
    assert.deepEqual(entity.genes.slice(4, 8), original.slice(4, 8));
    assert.deepEqual(entity.genes.slice(12, 16), original.slice(12, 16));
    assert.notDeepEqual(entity.genes.slice(0, 4), original.slice(0, 4));
  }
});

test("flips discard or create weights without a second numeric mutation or a dormant value", () => {
  const sim = quiet({switchMutationRate: 1, mutationRate: 1}, {weightRange: 0.02});
  const original = sim.entities[0].genes.map((_, i) => i % 4 ? 90 + i : 0);
  const off = sim.inherit(original);
  assert.deepEqual(off, original.map((value, i) => i % 4 ? null : value));
  assert.equal(sim.stats.switchFlips, 15);
  assert.equal(sim.stats.mutations, 0);

  sim.applyParameters({switchMutationRate: 0});
  let draws = 0;
  sim.random.unit = () => { draws++; return 0.75; };
  assert.deepEqual(sim.inherit(off), off);
  assert.equal(draws, 5); // The five biases are the only numerical copies.
  assert.equal(sim.stats.switchFlips, 15);

  sim.applyParameters({switchMutationRate: 1});
  draws = 0;
  const fresh = sim.inherit(off);
  assert.deepEqual(fresh, original.map((_, i) => i % 4 ? 0.01 : 0));
  assert.deepEqual(off, original.map((value, i) => i % 4 ? null : value));
  assert.equal(draws, 5 + 15 + 15); // Bias checks, switch checks, fresh weights.
  assert.equal(sim.stats.switchFlips, 30);
  assert.equal(sim.stats.mutations, 0);
});

test("parent and offspring copy switches independently from the same original pattern", () => {
  const sim = quiet({mutateParent: true, switchMutationRate: 0.5, mutationWidth: 0});
  const parent = sim.entities[0];
  const original = parent.genes.slice();
  let draws = 0;
  sim.random.unit = () => draws++ < 15 ? 0.25 : 0.75;
  const newborns = [];
  assert.ok(sim.reproduce(parent, newborns));
  assert.equal(draws, 30);
  assert.deepEqual(newborns[0].genes, original.map((value, i) => i % 4 ? null : value));
  assert.deepEqual(parent.genes, original);
  assert.equal(sim.stats.switchFlips, 15);
  assert.equal(sim.stats.mutations, 0);
});

test("persistence charges only effective ON inputs, even zero weights, before independent decisions", () => {
  const allOff = Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, false]));
  const sim = quiet({...allOff, growthEnabled: true, movementEnabled: true, connectionCost: 0.25, persistence: 0.1},
    {initialEnergy: 12});
  const entity = sim.entities[0];
  plan(entity);
  entity.genes[5] = null; // Growth has two ON inputs, movement three.
  entity.genes[4] = -12;
  entity.genes[6] = 1;
  let rolls = 0;
  sim.random.logUniform = () => { rolls++; return -0.1; };
  const both = sim.step();
  assert.equal(rolls, 2);
  assert.equal(both.activeConnections, 14);
  assert.equal(both.effectiveActiveConnections, 5);
  assert.equal(both.connectionMaintenancePaid, 1.25);
  assert.equal(entity.energy, 9.75);
  approx(both.meanDecisionProbabilities[1], 1 / (1 + Math.exp(2.25)));

  sim.applyParameters({movementEnabled: false});
  const one = sim.step();
  assert.equal(rolls, 3);
  assert.equal(one.effectiveActiveConnections, 2);
  assert.equal(one.connectionMaintenancePaid, 0.5);
  assert.equal(entity.energy, 8.25);
  assert.equal(one.meanDecisionProbabilities[3], null);
  approx(one.meanDecisionProbabilities[1], 1 / (1 + Math.exp(3.75)));
  assert.deepEqual(one.excludedActivities, ["Excretion", "Shrinking", "Movement", "Reproduction"]);

  sim.applyParameters({growthEnabled: false});
  const none = sim.step();
  assert.equal(rolls, 3);
  assert.equal(none.effectiveActiveConnections, 0);
  assert.equal(none.connectionMaintenancePaid, 0);
  assert.equal(entity.energy, 7.25);
  assert.deepEqual(none.meanDecisionProbabilities, Array(5).fill(null));

  sim.applyParameters({movementEnabled: true});
  const resumed = sim.step();
  assert.equal(rolls, 4);
  assert.equal(resumed.connectionMaintenancePaid, 0.75);
  assert.equal(resumed.activeConnections, 14);
  assert.equal(resumed.effectiveActiveConnections, 3);
  assert.equal(resumed.meanDecisionProbabilities[3], both.meanDecisionProbabilities[3]);
  assert.equal(entity.energy, 5.5);
});

test("an entity unable to pay the entire connection bill dies before decisions; exact payment survives", () => {
  const sim = quiet({connectionCost: 0.25, persistence: 0.1}, {radius: 1, founders: 2});
  const [survivor, other] = sim.entities;
  for (const entity of sim.entities) plan(entity);
  survivor.energy = 4.75;
  other.energy = 4.74;
  const result = sim.step();
  assert.equal(result.persistenceDeaths, 1);
  assert.equal(result.decisionCount, 1);
  assert.equal(survivor.energy, 0);
  assert.equal(result.connectionMaintenancePaid, 3.75);
  assert.equal(result.foodRecycled, other.mass);
});

test("excluding an activity preserves mixed switches, biases and ON weights through division and re-enabling", () => {
  const allOff = Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, false]));
  for (const mutateParent of [false, true]) {
    const sim = quiet({...allOff, movementEnabled: true, reproductionEnabled: true, connectionCost: 0.25,
      mutationRate: 1, switchMutationRate: 1, mutateParent}, {radius: 1, initialEnergy: 28});
    const parent = sim.entities[0];
    plan(parent, -500, -500, -500, 100, -500);
    parent.genes[13] = null;
    parent.genes[15] = -0.5;
    const movement = parent.genes.slice(12, 16);
    assert.equal(sim.step().connectionMaintenancePaid, 1.25);

    sim.applyParameters({movementEnabled: false});
    parent.genes[16] = 500;
    const divided = sim.step();
    assert.equal(divided.births, 1);
    assert.equal(divided.switchFlips, mutateParent ? 6 : 3);
    assert.equal(divided.mutations, mutateParent ? 2 : 1);
    assert.equal(divided.connectionMaintenancePaid, 0.75);
    assert.equal(divided.maintainedConnections, 3);
    assert.equal(divided.meanDecisionProbabilities[3], null);
    assert.deepEqual(divided.activities[3], {selected: 0, attempted: 0, succeeded: 0});
    for (const entity of sim.entities) assert.deepEqual(entity.genes.slice(12, 16), movement);

    sim.applyParameters({movementEnabled: true, reproductionEnabled: false});
    const resumed = sim.step();
    assert.equal(resumed.decisionCount, 2);
    assert.equal(resumed.activities[3].succeeded, 2);
    assert.equal(resumed.meanDecisionProbabilities[3], 1);
    assert.equal(resumed.effectiveActiveConnections, 4);
    assert.equal(resumed.connectionMaintenancePaid, 1);
    const exported = JSON.parse(JSON.stringify(sim.exportResults()));
    assert.equal(exported.initialParameters.switchMutationRate, 1);
    assert.equal(exported.appliedParameters.connectionCost, 0.25);
    assert.deepEqual(exported.parameterChanges, [
      {tick: 2, values: {movementEnabled: false}},
      {tick: 3, values: {movementEnabled: true, reproductionEnabled: false}},
    ]);
    assert.equal(exported.history[2].totals.switchFlips, divided.switchFlips);
    assert.equal(exported.history[2].totals.mutations, divided.mutations);
    for (const entity of exported.entities) {
      assert.deepEqual(entity.connectionSwitches.slice(9, 12), [false, true, true]);
      assert.deepEqual(entity.coefficients.slice(12, 16), movement);
      assert.equal(entity.effectiveActiveConnections, 2);
      assert.equal(entity.lastDecisionProbabilities[4], null);
      assert.equal(entity.lastDecisionTick, 3);
    }
  }
});

test("coefficient distributions use only carriers and distinguish OFF, a zero weight, and extinction", () => {
  const sim = quiet({excretionEnabled: false}, {radius: 1, founders: 3});
  const [first, second, third] = sim.entities;
  first.genes[1] = null;
  second.genes[1] = 0;
  third.genes[1] = 4;
  for (const entity of sim.entities) entity.genes[2] = null;
  const record = sim.record();
  assert.deepEqual(record.genes[1], [2, 2, 0, 4]);
  assert.deepEqual(record.genes[2], Array(4).fill(null));
  assert.deepEqual(record.connectionOnFractions.slice(0, 3), [2/3, 0, 1]);
  assert.equal(record.activeConnections, 41);
  assert.equal(record.effectiveActiveConnections, 36);
  const inspected = sim.inspect(second.cell, second.id).entity;
  assert.deepEqual(inspected.connectionSwitches.slice(0, 3), [true, false, true]);
  assert.deepEqual(inspected.coefficients.slice(1, 3), [0, null]);
  sim.applyParameters({suddenDeath: 1});
  const empty = sim.step();
  assert.deepEqual(empty.connectionOnFractions, Array(15).fill(null));
  assert.equal(empty.activeConnections, 0);
  assert.ok(empty.genes.every(distribution => distribution.every(value => value === null)));
});

test("zero switch-error rate preserves the original numerical inheritance and draw sequence", () => {
  const sim = quiet({mutationRate: 0.4, switchMutationRate: 0, connectionCost: 0});
  const original = sim.entities[0].genes;
  const reference = new Random();
  reference.state.set(sim.random.state);
  const expected = original.map(value =>
    reference.unit() < sim.params.mutationRate ? mutateValue(value, sim.params, reference) : value);
  assert.deepEqual(sim.inherit(original), expected);
  assert.deepEqual(sim.random.state, reference.state);
  assert.equal(sim.stats.switchFlips, 0);
});

test("a sparse founder tree changes only the chosen inputs in the seeded preview", () => {
  const setup = {radius: 1, founders: 4};
  const baseline = quiet({}, setup);
  const startingGeneSwitches = Object.fromEntries(Object.keys(DEFAULT_SETUP.startingGeneSwitches).map(key => [key, false]));
  startingGeneSwitches["movement.energy"] = true;
  const sparse = quiet({}, {...setup, startingGeneSwitches});
  for (let i = 0; i < sparse.entities.length; i++) {
    const founder = sparse.entities[i];
    assert.equal(founder.cell, baseline.entities[i].cell);
    for (let j = 0; j < founder.genes.length; j++) {
      assert.equal(founder.genes[j], j % 4 === 0 || j === 14 ? baseline.entities[i].genes[j] : null);
    }
  }
  assert.equal(sparse.history[0].activeConnections, 4);
  assert.equal(sparse.history[0].connectionHistogram[1], 4);
  assert.equal(sparse.history[0].distinctPatterns, 1);
  assert.deepEqual(sparse.geneSwitchChanges, []);
  const partial = quiet({}, {startingGeneSwitches: {"growth.mass": false}});
  assert.equal(partial.history[0].activeConnections, 14);
});

test("manual edits clear or redraw every targeted weight once at the start of the tick", () => {
  const sim = quiet({connectionCost: 0.125, growthEnabled: false}, {radius: 1, founders: 3, initialEnergy: 25});
  for (const entity of sim.entities) plan(entity);
  sim.entities[0].genes[5] = null;
  const old = sim.entities.map(entity => entity.genes.slice());
  const reset = sim.step({"growth.mass": true, "movement.energy": false});
  assert.equal(reset.maintainedConnections, 3 * 11);
  assert.equal(reset.connectionMaintenancePaid, 3 * 11 * 0.125);
  const draws = sim.entities.map(entity => entity.genes[5]);
  assert.equal(new Set(draws).size, 3);
  assert.ok(draws.every(weight => Math.abs(weight) <= 0.01 && weight !== 0));
  for (let i = 0; i < sim.entities.length; i++) {
    const expected = old[i].slice();
    expected[5] = draws[i];
    expected[14] = null;
    assert.deepEqual(sim.entities[i].genes, expected);
  }
  assert.equal(reset.geneSwitchReset, true);
  assert.equal(reset.mutations + reset.switchFlips, 0);
  assert.equal(sim.step().geneSwitchReset, false);
  assert.deepEqual(sim.entities.map(entity => entity.genes[5]), draws);
  const data = JSON.parse(JSON.stringify(sim.exportResults()));
  assert.equal(data.setup.startingGeneSwitches["movement.energy"], true);
  assert.equal(data.appliedGeneSwitches["movement.energy"], false);
  assert.deepEqual(data.geneSwitchChanges, [{tick: 1, values: {"growth.mass": true, "movement.energy": false},
    population: 3, weightsDrawn: 3, weightsRemoved: 3}]);
  assert.equal(data.history[0].activeConnections, 45);
});

test("offspring can mutate a manually cleared input in the same tick", () => {
  const sim = quiet({switchMutationRate: 1}, {initialEnergy: 20});
  const parent = sim.entities[0];
  plan(parent, -500, -500, -500, -500, 500);
  const frame = sim.step({"reproduction.mass": false});
  assert.equal(frame.births, 1);
  assert.equal(frame.switchFlips, 15);
  assert.equal(frame.mutations, 0);
  assert.equal(parent.genes[17], null);
  assert.ok(Number.isFinite(sim.entities[1].genes[17]));
  assert.equal(frame.connectionOnFractions[12], 0.5);
  assert.equal(sim.geneSwitchChanges[0].population, 1);
});

test("diversity distinguishes switch identities and sign statistics include only ON carriers", () => {
  const sim = quiet({excretionEnabled: false}, {radius: 1, founders: 4});
  for (const entity of sim.entities) {
    for (let i = 0; i < entity.genes.length; i++) if (i % 4) entity.genes[i] = null;
  }
  sim.entities[0].genes[1] = -10;
  sim.entities[1].genes[1] = 0.25;
  sim.entities[2].genes[2] = 0;
  const stats = sim.record();
  assert.equal(stats.distinctPatterns, 3);
  approx(stats.effectivePatterns, 8/3);
  assert.equal(stats.dominantPatternShare, 0.5);
  assert.equal(stats.leadingPattern, "1" + "0".repeat(14));
  assert.equal(stats.leadingPatternCount, 1);
  assert.deepEqual(stats.connectionHistogram, [1, 3, ...Array(14).fill(0)]);
  assert.deepEqual(stats.weightSigns.negative.slice(0, 3), [1, 0, 0]);
  assert.deepEqual(stats.weightSigns.zero.slice(0, 3), [0, 1, 0]);
  assert.deepEqual(stats.weightSigns.positive.slice(0, 3), [1, 0, 0]);
  sim.entities[2].genes[2] = null;
  const tied = sim.record();
  assert.equal(tied.distinctPatterns, 2);
  assert.equal(tied.effectivePatterns, 2);
  assert.equal(tied.leadingPatternCount, 2);
  assert.equal(tied.leadingPattern, null);
  sim.applyParameters({suddenDeath: 1});
  const empty = sim.step();
  assert.equal(empty.distinctPatterns, 0);
  assert.equal(empty.effectivePatterns, null);
  assert.equal(empty.dominantPatternShare, null);
  assert.equal(empty.leadingPatternCount, 0);
  assert.deepEqual(empty.connectionHistogram, Array(16).fill(0));
});

test("observation leaves evolution unchanged and population and food accounting hold", () => {
  const original = new Simulation({entropy: deterministicEntropy()});
  const observed = new Simulation({entropy: deterministicEntropy()});
  let previous = observed.history[0];
  for (let tick = 1; tick <= 300; tick++) {
    original.step();
    const next = observed.step();
    observed.snapshot(0);
    approx(next.food, previous.food + next.foodProduced - next.foodConsumed + next.foodRecycled);
    assert.equal(next.population, previous.population + next.births - next.suddenDeaths - next.persistenceDeaths);
    assert.ok(observed.entities.every(entity => entity.mass >= observed.minMass && entity.waste >= 0 && entity.energy >= 0));
    previous = next;
  }
  assert.deepEqual(observed.exportResults(), original.exportResults());
});
