"use strict";

const Petri = (() => {
  const VERSION = "0.2";
  const ACTIVITY_NAMES = {
    excretionEnabled: "Excretion", growthEnabled: "Growth", shrinkingEnabled: "Shrinking",
    movementEnabled: "Movement", reproductionEnabled: "Reproduction",
  };
  const ACTIVITIES = Object.values(ACTIVITY_NAMES);
  const ACTIVITY_ENABLED_KEYS = Object.keys(ACTIVITY_NAMES);
  const COEFFICIENTS = ["Bias", "Mass", "Energy", "Waste"];
  const DEFAULT_SETUP = Object.freeze({
    radius: 5, founders: 30, initialMass: 10, initialEnergy: 40, initialWaste: 0,
    initialFood: 0, biasLow: -3, biasHigh: -1.5, weightRange: 0.01,
  });
  const DEFAULT_PARAMS = Object.freeze({
    foodMean: 3, foodSD: 1.5, intake: 0.35, energyPerFood: 1, energyWasteRatio: 2,
    foodPerMass: 1, energyCapacity: 8, wasteCapacity: 4, persistence: 0.15,
    excretionRate: 1.2, excretionCost: 0.05, growthFraction: 0.1, shrinkFraction: 0.1,
    growthSpread: 0.2, movementCost: 0.02, reproductionCost: 2, divisionLoss: 0.1,
    offspringShare: 0.5, suddenDeath: 0.002, mutationRate: 0.01, mutationWidth: 0.2,
    mutationSharpness: 16, mutationTail: 3, mutateParent: false,
    ...Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, true])),
  });
  const DEFAULT_PAUSE_TICK = 0;
  const LIFESPAN_WINDOW = 100;
  const DIRECTIONS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const UINT32 = 4294967296;

  function avalanche(value) {
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
  }

  class Random {
    constructor() {
      this.state = new Uint32Array(4);
    }

    reseed(globalSeed, salt) {
      for (let i = 0; i < 4; i++) {
        this.state[i] = avalanche((globalSeed[i] + salt[i] + Math.imul(i + 1, 0x9e3779b9)) >>> 0);
      }
      if (this.state.every(value => value === 0)) this.state[0] = 1;
    }

    word() {
      const s = this.state;
      const rotated = Math.imul(s[1], 5);
      const result = Math.imul((rotated << 7) | (rotated >>> 25), 9);
      const shift = s[1] << 9;
      s[2] ^= s[0];
      s[3] ^= s[1];
      s[1] ^= s[2];
      s[0] ^= s[3];
      s[2] ^= shift;
      s[3] = (s[3] << 11) | (s[3] >>> 21);
      return result >>> 0;
    }

    unit() {
      return ((this.word() >>> 5) * 67108864 + (this.word() >>> 6)) / 9007199254740992;
    }

    logUniform() {
      // Leading zero words let very small probabilities remain sampleable.
      let zeroWords = 0;
      let high = this.word();
      while (high === 0) {
        zeroWords++;
        high = this.word();
      }
      return Math.log((high + this.word() / UINT32) / UINT32) - zeroWords * 32 * Math.LN2;
    }
  }

  function logGamma(shape, random) {
    if (shape < 1) return logGamma(shape + 1, random) + random.logUniform() / shape;
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      const z = Math.sqrt(-2 * random.logUniform()) * Math.cos(2 * Math.PI * random.unit());
      const next = 1 + c * z;
      if (next <= 0) continue;
      const logV = 3 * Math.log(next);
      const u = random.unit();
      if (u < 1 - 0.0331 * z ** 4 || Math.log(u) < 0.5 * z * z + d * (logV - Math.expm1(logV))) {
        return Math.log(d) + logV;
      }
    }
  }

  function foodIncome(mean, deviation, random) {
    if (mean === 0 || deviation === 0) return mean;
    const shape = (mean / deviation) ** 2;
    return Math.exp(logGamma(shape, random) + Math.log(mean / shape));
  }

  function mutateValue(value, params, random) {
    if (value === 0) return 0;
    const k = params.mutationSharpness;
    const a = 1 / k;
    const b = (params.mutationTail - 1) / k;
    while (true) {
      // A ratio of independent gamma variates gives the specified beta-prime transform.
      const logMagnitude = Math.log(params.mutationWidth) + (logGamma(a, random) - logGamma(b, random)) / k;
      const sign = random.unit() < 0.5 ? -1 : 1;
      const candidate = logMagnitude < 700
        ? value * (1 + sign * Math.exp(logMagnitude))
        : sign * Math.sign(value) * Math.exp(Math.log(Math.abs(value)) + logMagnitude);
      if (Number.isFinite(candidate)) return candidate;
    }
  }

  function chooseActivity(logit, random, rareOdds = Math.exp(-Math.abs(logit))) {
    const logRare = -Math.abs(logit) - Math.log1p(rareOdds);
    const rare = random.logUniform() < logRare;
    return logit < 0 ? rare : !rare;
  }

  function dotProduct(entity, offset) {
    const genes = entity.genes;
    const bias = genes[offset];
    const massWeight = genes[offset + 1];
    const energyWeight = genes[offset + 2];
    const wasteWeight = genes[offset + 3];
    const sum = bias + massWeight * entity.mass + energyWeight * entity.energy + wasteWeight * entity.waste;
    if (Number.isFinite(sum)) return sum;
    const weightScale = Math.max(Math.abs(bias), Math.abs(massWeight), Math.abs(energyWeight), Math.abs(wasteWeight));
    const stateScale = Math.max(1, entity.mass, entity.energy, entity.waste);
    const scaled = (bias / weightScale) / stateScale
      + (massWeight / weightScale) * (entity.mass / stateScale)
      + (energyWeight / weightScale) * (entity.energy / stateScale)
      + (wasteWeight / weightScale) * (entity.waste / stateScale);
    return (scaled * weightScale) * stateScale;
  }

  function circumference(mass) {
    return 2 * Math.sqrt(Math.PI) * Math.sqrt(mass);
  }

  function fits(amount, capacity) {
    return Number.isFinite(amount) && (amount <= capacity || amount - capacity <= 4 * Number.EPSILON * amount);
  }

  function makeGrid(radius, food) {
    const cells = [];
    const lookup = new Map();
    for (let r = -radius; r <= radius; r++) {
      for (let q = Math.max(-radius, -r - radius); q <= Math.min(radius, -r + radius); q++) {
        lookup.set(q + "," + r, cells.length);
        cells.push({q, r, food, released: 0, feeders: [], neighbors: []});
      }
    }
    for (const cell of cells) {
      for (const [dq, dr] of DIRECTIONS) {
        const neighbor = lookup.get((cell.q + dq) + "," + (cell.r + dr));
        if (neighbor !== undefined) cell.neighbors.push(neighbor);
      }
    }
    return cells;
  }

  function feedCell(cell, params, wastePerFood) {
    const feeders = cell.feeders;
    if (cell.food <= 0 || feeders.length === 0) return 0;
    let totalDemand = 0;
    let upper = 0;
    for (const entity of feeders) {
      const freeEnergy = params.energyCapacity * entity.mass - entity.energy;
      const freeWaste = params.wasteCapacity * entity.mass - entity.waste;
      entity.demand = freeEnergy > 0 && freeWaste > 0
        ? Math.min(params.intake * entity.surface, freeEnergy / params.energyPerFood, freeWaste / wastePerFood)
        : 0;
      totalDemand += entity.demand;
      upper = Math.max(upper, entity.demand / entity.surface);
    }

    const target = Math.min(cell.food, totalDemand);
    if (target === 0) return 0;
    let lambda = Infinity;
    if (target < totalDemand) {
      let lower = 0;
      for (let iteration = 0; iteration < 60; iteration++) {
        const middle = lower + (upper - lower) / 2;
        if (middle === lower || middle === upper) break;
        let sum = 0;
        for (const entity of feeders) sum += Math.min(entity.demand, middle * entity.surface);
        if (sum <= target) lower = middle;
        else upper = middle;
        if (sum === target) break;
      }
      lambda = lower;
    }

    let eaten = 0;
    for (const entity of feeders) {
      const amount = Math.min(entity.demand, lambda * entity.surface);
      entity.energy += amount * params.energyPerFood;
      entity.waste += amount * wastePerFood;
      eaten += amount;
    }
    cell.food = Math.max(0, cell.food - eaten);
    return eaten;
  }

  function tickStats() {
    return {
      births: 0, suddenDeaths: 0, persistenceDeaths: 0, mutations: 0,
      foodProduced: 0, foodConsumed: 0, foodRecycled: 0,
      activities: ACTIVITIES.map(() => ({selected: 0, attempted: 0, succeeded: 0})),
      decisionCount: 0, meanDecisionProbabilities: ACTIVITIES.map(() => null),
    };
  }

  function entityState(entity) {
    return {
      id: entity.id, parentId: entity.parentId, founderId: entity.founderId,
      generation: entity.generation, born: entity.born, cell: entity.cell,
      mass: entity.mass, surface: entity.surface, energy: entity.energy, waste: entity.waste,
      coefficients: Array.from(entity.genes),
      lastDecisionProbabilities: entity.lastDecisionProbabilities
        ? Array.from(entity.lastDecisionProbabilities) : null,
    };
  }

  class Simulation {
    constructor({setup = {}, params = {}, entropy = target => globalThis.crypto.getRandomValues(target), seed} = {}) {
      this.params = {...DEFAULT_PARAMS, ...params};
      this.setup = {...DEFAULT_SETUP, ...setup};
      this.entropy = entropy;
      this.globalSeed = seed ? new Uint32Array(seed) : entropy(new Uint32Array(4));
      this.tickSalt = new Uint32Array(4);
      this.random = new Random();
      this.random.reseed(this.globalSeed, this.tickSalt);
      this.tick = 0;
      this.nextId = 1;
      this.minMass = this.setup.initialMass * 0.01;
      this.cells = makeGrid(this.setup.radius, this.setup.initialFood);
      this.entities = [];
      this.history = [];
      this.parameterChanges = [];
      this.totals = {births: 0, suddenDeaths: 0, persistenceDeaths: 0, mutations: 0};
      this.recentLifespans = [];
      this.lifespanSum = 0;
      this.nextLifespanIndex = 0;
      this.peakPopulation = this.setup.founders;
      this.stats = tickStats();
      this.initialParams = {...this.params};
      this.makeFounders();
      this.record();
    }

    makeFounders() {
      const {founders, initialMass, initialEnergy, initialWaste, biasLow, biasHigh, weightRange} = this.setup;
      const places = this.cells.map((_, index) => index);
      const energy = Math.min(initialEnergy, initialMass * this.params.energyCapacity);
      const waste = Math.min(initialWaste, initialMass * this.params.wasteCapacity);
      for (let i = 0; i < founders; i++) {
        const chosen = i + Math.floor(this.random.unit() * (places.length - i));
        [places[i], places[chosen]] = [places[chosen], places[i]];
        const genes = new Float64Array(ACTIVITIES.length * COEFFICIENTS.length);
        for (let offset = 0; offset < genes.length; offset += 4) {
          genes[offset] = biasLow + this.random.unit() * (biasHigh - biasLow);
          for (let weight = 1; weight < 4; weight++) {
            genes[offset + weight] = weightRange * (2 * this.random.unit() - 1);
          }
        }
        this.entities.push(this.makeEntity(places[i], initialMass, energy, waste, genes));
      }
    }

    makeEntity(cell, mass, energy, waste, genes, parent) {
      const id = this.nextId++;
      return {
        id, cell, mass, surface: circumference(mass), energy, waste, genes,
        parentId: parent?.id ?? null, founderId: parent?.founderId ?? id,
        generation: parent ? parent.generation + 1 : 0, born: this.tick,
        demand: 0, plan: [], lastDecisionProbabilities: null,
      };
    }

    applyParameters(changes) {
      const actual = {};
      for (const key of Object.keys(changes)) {
        if (this.params[key] === changes[key]) continue;
        this.params[key] = changes[key];
        actual[key] = changes[key];
      }
      if (Object.keys(actual).length) this.parameterChanges.push({tick: this.tick + 1, values: actual});
    }

    recordDeath(entity) {
      const lifespan = this.tick - entity.born;
      const index = this.nextLifespanIndex;
      this.lifespanSum += lifespan - (this.recentLifespans[index] ?? 0);
      this.recentLifespans[index] = lifespan;
      this.nextLifespanIndex = (index + 1) % LIFESPAN_WINDOW;
      this.cells[entity.cell].released += entity.mass;
    }

    step() {
      this.tick++;
      this.entropy(this.tickSalt);
      this.random.reseed(this.globalSeed, this.tickSalt);
      this.stats = tickStats();
      for (const cell of this.cells) cell.feeders.length = 0;

      // 1. Sudden death.
      const feeding = [];
      for (const entity of this.entities) {
        if (this.params.suddenDeath > 0 && this.random.unit() < this.params.suddenDeath) {
          this.stats.suddenDeaths++;
          this.recordDeath(entity);
        } else {
          feeding.push(entity);
          this.cells[entity.cell].feeders.push(entity);
        }
      }

      // 2. Environment. Retain any prior unconsumed food.
      for (const cell of this.cells) {
        const amount = foodIncome(this.params.foodMean, this.params.foodSD, this.random);
        cell.food += amount;
        this.stats.foodProduced += amount;
      }

      // 3. Simultaneous feeding. 4. Persistence.
      const wastePerFood = this.params.energyPerFood / this.params.energyWasteRatio;
      for (const cell of this.cells) {
        this.stats.foodConsumed += feedCell(cell, this.params, wastePerFood);
      }
      this.entities = [];
      for (const entity of feeding) {
        const cost = this.params.persistence * entity.mass;
        if (entity.energy < cost) {
          this.stats.persistenceDeaths++;
          this.recordDeath(entity);
        } else {
          entity.energy -= cost;
          this.entities.push(entity);
        }
      }

      // 5. Decisions use the same pre-execution state within each entity.
      const enabled = ACTIVITY_ENABLED_KEYS.map(key => this.params[key]);
      const anyEnabled = enabled.some(Boolean);
      const probabilitySums = new Float64Array(ACTIVITIES.length);
      for (const entity of this.entities) {
        entity.plan.length = 0;
        if (!anyEnabled) {
          entity.lastDecisionProbabilities = null;
          continue;
        }
        const probabilities = entity.lastDecisionProbabilities ??= new Array(ACTIVITIES.length);
        for (let activity = 0; activity < ACTIVITIES.length; activity++) {
          if (!enabled[activity]) {
            probabilities[activity] = null;
            continue;
          }
          const logit = dotProduct(entity, activity * COEFFICIENTS.length);
          const rareOdds = Math.exp(-Math.abs(logit));
          const probability = (logit < 0 ? rareOdds : 1) / (1 + rareOdds);
          probabilities[activity] = probability;
          probabilitySums[activity] += probability;
          if (!chooseActivity(logit, this.random, rareOdds)) continue;
          entity.plan.push({activity, logit, tie: this.random.unit()});
          this.stats.activities[activity].selected++;
        }
        entity.plan.sort((a, b) => a.logit === b.logit ? a.tie - b.tie : (a.logit > b.logit ? -1 : 1));
      }
      const decisionCount = anyEnabled ? this.entities.length : 0;
      this.stats.decisionCount = decisionCount;
      if (decisionCount) {
        this.stats.meanDecisionProbabilities = Array.from(probabilitySums, (sum, activity) =>
          enabled[activity] ? sum / decisionCount : null);
      }

      // 6. Execute in priority order against the current state.
      const newborns = [];
      for (const entity of this.entities) {
        for (const {activity} of entity.plan) {
          const stats = this.stats.activities[activity];
          stats.attempted++;
          if (!this.execute(activity, entity, newborns)) continue;
          stats.succeeded++;
          if (activity === 4) break;
        }
      }

      // 7. Finalization. This food and these newborns can participate next tick.
      for (const entity of newborns) this.entities.push(entity);
      for (const cell of this.cells) {
        const amount = cell.released * this.params.foodPerMass;
        cell.food += amount;
        this.stats.foodRecycled += amount;
        cell.released = 0;
      }
      for (const key of Object.keys(this.totals)) this.totals[key] += this.stats[key];
      this.peakPopulation = Math.max(this.peakPopulation, this.entities.length);
      return this.record();
    }

    execute(activity, entity, newborns) {
      const params = this.params;
      switch (activity) {
        case 0: {
          const affordable = params.excretionCost === 0 ? Infinity : entity.energy / params.excretionCost;
          const amount = Math.min(entity.waste, affordable, entity.surface * params.excretionRate);
          if (amount <= 0) return false;
          entity.energy = Math.max(0, entity.energy - amount * params.excretionCost);
          entity.waste -= amount;
          return true;
        }
        case 1: {
          const added = entity.mass * params.growthFraction;
          const mass = entity.mass + added;
          const cost = added * params.foodPerMass * params.energyPerFood * (1 + params.growthSpread);
          if (mass === entity.mass || entity.energy < cost) return false;
          if (!Number.isFinite(mass)) throw new RangeError("A simulated mass exceeded the browser’s numerical range.");
          entity.energy -= cost;
          entity.mass = mass;
          entity.surface = circumference(entity.mass);
          return true;
        }
        case 2: {
          const removed = entity.mass * params.shrinkFraction;
          const mass = entity.mass - removed;
          const gainedEnergy = removed * params.foodPerMass * params.energyPerFood;
          const energy = entity.energy + gainedEnergy;
          const waste = entity.waste + gainedEnergy / params.energyWasteRatio;
          if (mass === entity.mass || mass < this.minMass
            || !fits(energy, mass * params.energyCapacity) || !fits(waste, mass * params.wasteCapacity)) return false;
          entity.mass = mass;
          entity.surface = circumference(mass);
          entity.energy = energy;
          entity.waste = waste;
          return true;
        }
        case 3: {
          const cost = entity.mass * params.movementCost;
          const neighbors = this.cells[entity.cell].neighbors;
          if (!neighbors.length || entity.energy < cost) return false;
          entity.cell = neighbors[Math.floor(this.random.unit() * neighbors.length)];
          entity.energy -= cost;
          return true;
        }
        case 4:
          return this.reproduce(entity, newborns);
        default:
          throw new RangeError("Unknown activity");
      }
    }

    reproduce(entity, newborns) {
      const params = this.params;
      if (entity.energy < params.reproductionCost) return false;
      const lost = entity.mass * params.divisionLoss;
      const mass = entity.mass - lost;
      const energy = entity.energy - params.reproductionCost;
      const childMass = mass * params.offspringShare;
      const childEnergy = energy * params.offspringShare;
      const childWaste = entity.waste * params.offspringShare;
      const parentMass = mass - childMass;
      const parentEnergy = energy - childEnergy;
      const parentWaste = entity.waste - childWaste;
      if (childMass < this.minMass || parentMass < this.minMass
        || !fits(childEnergy, childMass * params.energyCapacity)
        || !fits(parentEnergy, parentMass * params.energyCapacity)
        || !fits(childWaste, childMass * params.wasteCapacity)
        || !fits(parentWaste, parentMass * params.wasteCapacity)) return false;

      const original = entity.genes;
      const childGenes = this.inherit(original);
      if (params.mutateParent) entity.genes = this.inherit(original);
      entity.mass = parentMass;
      entity.surface = circumference(parentMass);
      entity.energy = parentEnergy;
      entity.waste = parentWaste;
      newborns.push(this.makeEntity(entity.cell, childMass, childEnergy, childWaste, childGenes, entity));
      this.cells[entity.cell].released += lost;
      this.stats.births++;
      return true;
    }

    inherit(original) {
      const genes = original.slice();
      if (this.params.mutationRate === 0 || this.params.mutationWidth === 0) return genes;
      for (let i = 0; i < genes.length; i++) {
        const activity = Math.floor(i / COEFFICIENTS.length);
        if (!this.params[ACTIVITY_ENABLED_KEYS[activity]]) continue;
        if (this.random.unit() >= this.params.mutationRate) continue;
        const mutated = mutateValue(genes[i], this.params, this.random);
        if (mutated !== genes[i]) this.stats.mutations++;
        genes[i] = mutated;
      }
      return genes;
    }

    record() {
      const population = this.entities.length;
      const geneLength = ACTIVITIES.length * COEFFICIENTS.length;
      const genes = Array.from({length: geneLength}, () => [0, 0, Infinity, -Infinity]);
      const scales = new Float64Array(geneLength);
      let energy = 0;
      let waste = 0;
      let mass = 0;
      let count = 0;
      let generation = 0;
      for (const entity of this.entities) {
        count++;
        energy += entity.energy;
        waste += entity.waste;
        mass += entity.mass;
        generation = Math.max(generation, entity.generation);
        for (let i = 0; i < geneLength; i++) {
          const value = entity.genes[i];
          const distribution = genes[i];
          const magnitude = Math.abs(value);
          if (magnitude > scales[i]) {
            const ratio = scales[i] / magnitude;
            distribution[0] *= ratio;
            distribution[1] *= ratio * ratio;
            scales[i] = magnitude;
          }
          const normalized = scales[i] ? value / scales[i] : 0;
          const delta = normalized - distribution[0];
          distribution[0] += delta / count;
          distribution[1] += delta * (normalized - distribution[0]);
          distribution[2] = Math.min(distribution[2], value);
          distribution[3] = Math.max(distribution[3], value);
        }
      }
      for (let i = 0; i < geneLength; i++) {
        const distribution = genes[i];
        if (population) {
          distribution[0] *= scales[i];
          distribution[1] = Math.sqrt(Math.min(1, Math.max(0, distribution[1]) / population)) * scales[i];
        } else {
          distribution.fill(null);
        }
      }
      const food = this.cells.reduce((total, cell) => total + cell.food, 0);
      const energyCapacity = mass * this.params.energyCapacity;
      const wasteCapacity = mass * this.params.wasteCapacity;
      if (![mass, energy, waste, food, energyCapacity, wasteCapacity].every(Number.isFinite)) {
        throw new RangeError("A simulated stock exceeded the browser’s numerical range.");
      }

      const lifespanSamples = this.recentLifespans.length;
      const result = {
        tick: this.tick, population, food, mass, energy, waste, generation, genes,
        lifespanSamples, meanLifespan: lifespanSamples ? this.lifespanSum / lifespanSamples : null,
        energyCapacity, wasteCapacity,
        peakPopulation: this.peakPopulation, totals: {...this.totals}, ...this.stats,
      };
      this.history.push(result);
      return result;
    }

    inspect(cell, entityId) {
      const occupants = this.entities.filter(entity => entity.cell === cell);
      const selected = occupants.find(entity => entity.id === entityId) ?? occupants[0];
      return {
        cell, food: this.cells[cell]?.food, ids: occupants.map(entity => entity.id),
        entity: selected ? entityState(selected) : null,
      };
    }

    snapshot(cell, entityId) {
      const counts = new Uint32Array(this.cells.length);
      for (const entity of this.entities) counts[entity.cell]++;
      return {
        tick: this.tick,
        cells: this.cells.map(({q, r, food}, index) => ({q, r, food, population: counts[index]})),
        inspect: this.inspect(cell, entityId),
      };
    }

    exportResults() {
      return {
        model: "Petri Dish", version: VERSION, tick: this.tick, minimumMass: this.minMass,
        setup: this.setup, initialParameters: this.initialParams, appliedParameters: this.params,
        parameterChanges: this.parameterChanges, activityOrder: ACTIVITIES, coefficientOrder: COEFFICIENTS,
        coefficientStatistics: ["mean", "populationStandardDeviation", "minimum", "maximum"],
        history: this.history, entities: this.entities.map(entityState),
        cells: this.cells.map(({q, r, food}) => ({q, r, food})),
      };
    }
  }

  return {
    VERSION,
    Simulation, ACTIVITIES, ACTIVITY_ENABLED_KEYS, COEFFICIENTS, DEFAULT_SETUP, DEFAULT_PARAMS, DEFAULT_PAUSE_TICK,
    Random, feedCell, foodIncome, mutateValue, chooseActivity, circumference,
  };
})();

if (typeof module === "object" && module.exports) module.exports = Petri;
