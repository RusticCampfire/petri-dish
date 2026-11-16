"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {
  Simulation, Random, DEFAULT_PARAMS, feedCell, foodIncome, mutateValue, chooseActivity, circumference,
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
    params: {foodMean: 0, suddenDeath: 0, persistence: 0, mutationRate: 0, ...params},
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
  for (const entity of sim.entities) {
    approx(entity.surface, 2 * Math.sqrt(Math.PI * 10));
    assert.equal(entity.genes.length, 20);
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
  assert.equal(sim.step().suddenDeaths, 2);
});

test("decision readouts average the probabilities used before execution and omit newborns", () => {
  const sim = quiet({foodMean: 2, foodSD: 0, persistence: 0.1}, {radius: 1, founders: 2});
  const [parent, other] = sim.entities;
  const initial = sim.history[0];
  assert.equal(initial.decisionCount, 0);
  assert.deepEqual(initial.meanDecisionProbabilities, [null, null, null, null, null]);
  assert.equal(sim.inspect(parent.cell, parent.id).entity.lastDecisionProbabilities, null);
  plan(parent, -3, 100, -500, -500, 200);
  parent.genes.set([0.1, 0.25, 0.5], 1);
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
