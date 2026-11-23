"use strict";

// Petri Dish's simulation engine. In Node.js, require("./model.js") exposes
// the same Simulation class used by the browser worker. One step is one tick.
const Petri = (() => {
  const VERSION = "0.4.1";
  const ACTIVITY_NAMES = {
    excretionEnabled: "Excretion", growthEnabled: "Growth", shrinkingEnabled: "Shrinking",
    movementEnabled: "Movement", reproductionEnabled: "Reproduction",
  };
  const ACTIVITIES = Object.values(ACTIVITY_NAMES);
  const ACTIVITY_ENABLED_KEYS = Object.keys(ACTIVITY_NAMES);
  const COEFFICIENTS = ["Bias", "Mass", "Energy", "Waste"];
  const GENE_TREE = {
    label: "Gene switches",
    children: ACTIVITIES.map((activity, a) => ({
      label: activity,
      children: COEFFICIENTS.slice(1).map((input, j) => ({
        label: input, key: activity.toLowerCase() + "." + input.toLowerCase(),
        coefficient: a * COEFFICIENTS.length + j + 1,
      })),
    })),
  };
  function connectionLeaves(node) {
    return node.children ? node.children.flatMap(connectionLeaves) : [node];
  }
  const CONNECTIONS = connectionLeaves(GENE_TREE);
  // Pack small patterns as exact integers. Longer trees use full bit strings without truncation.
  const NUMERIC_PATTERN = CONNECTIONS.length <= 53;
  const INPUT_AT = new Array(ACTIVITIES.length * COEFFICIENTS.length).fill(-1);
  CONNECTIONS.forEach((gene, index) => { INPUT_AT[gene.coefficient] = index; });
  const DEFAULT_SETUP = Object.freeze({
    radius: 5, founders: 30, initialMass: 10, initialEnergy: 40, initialWaste: 0,
    initialFood: 0, biasLow: -3, biasHigh: -1.5, weightRange: 5,
    startingGeneSwitches: Object.freeze(Object.fromEntries(CONNECTIONS.map(({key}) => [key, key === "reproduction.energy"]))),
  });
  const DEFAULT_PARAMS = Object.freeze({
    foodMean: 2, foodSD: 1.5, intake: 0.35, energyPerFood: 1, energyWasteRatio: 2,
    foodPerMass: 1, energyCapacity: 8, wasteCapacity: 4, persistence: 0.15, connectionCost: 0.01,
    failedAttemptFraction: 0.01, excretionRate: 1.2, excretionCost: 0.05,
    growthFraction: 0.1, shrinkFraction: 0.1,
    growthSpread: 0.2, movementCost: 0.02, reproductionCost: 2, divisionLoss: 0.1,
    offspringShare: 0.5, suddenDeath: 0.008, mutationRate: 0.01, switchMutationRate: 0, mutationWidth: 0.2,
    mutationSharpness: 16, mutationTail: 3, mutateParent: false,
    ...Object.fromEntries(ACTIVITY_ENABLED_KEYS.map(key => [key, true])),
  });
  const DEFAULT_PAUSE_TICK = 0;
  const SPEEDS = [1, 5, 10, 25, 50, 100, 250, 0];
  const REFRESHES = [0, 100, 500, 1000, 2000, 5000, 10000];
  const CHART_WINDOW = 5000;
  const SUCCESS_RATE_AVERAGE_TICKS = 100;
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

  function sigmoid(logit, rareOdds = Math.exp(-Math.abs(logit))) {
    return (logit < 0 ? rareOdds : 1) / (1 + rareOdds);
  }

  function chooseActivity(logit, random, rareOdds = Math.exp(-Math.abs(logit))) {
    const logRare = -Math.abs(logit) - Math.log1p(rareOdds);
    const rare = random.logUniform() < logRare;
    return logit < 0 ? rare : !rare;
  }

  function initialWeight(range, random) {
    return range * (2 * random.unit() - 1);
  }

  // A null input slot is the inherited OFF state. There is no dormant weight.
  // Bias slots and ON inputs always contain a finite number, including zero.
  function enabledConnectionCount(genes, enabled) {
    let count = 0;
    for (let activity = 0; activity < enabled.length; activity++) {
      if (!enabled[activity]) continue;
      const offset = activity * COEFFICIENTS.length;
      for (let j = 1; j < COEFFICIENTS.length; j++) {
        if (genes[offset + j] !== null) count++;
      }
    }
    return count;
  }

  function dotProduct(entity, offset) {
    const genes = entity.genes;
    const bias = genes[offset];
    const massWeight = genes[offset + 1];
    const energyWeight = genes[offset + 2];
    const wasteWeight = genes[offset + 3];
    const sum = bias
      + (massWeight === null ? 0 : massWeight * entity.mass)
      + (energyWeight === null ? 0 : energyWeight * entity.energy)
      + (wasteWeight === null ? 0 : wasteWeight * entity.waste);
    if (Number.isFinite(sum)) return sum;
    const weightScale = Math.max(Math.abs(bias), Math.abs(massWeight ?? 0), Math.abs(energyWeight ?? 0), Math.abs(wasteWeight ?? 0));
    const stateScale = Math.max(1, massWeight === null ? 0 : entity.mass,
      energyWeight === null ? 0 : entity.energy, wasteWeight === null ? 0 : entity.waste);
    const scaled = (bias / weightScale) / stateScale
      + (massWeight === null ? 0 : (massWeight / weightScale) * (entity.mass / stateScale))
      + (energyWeight === null ? 0 : (energyWeight / weightScale) * (entity.energy / stateScale))
      + (wasteWeight === null ? 0 : (wasteWeight / weightScale) * (entity.waste / stateScale));
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
      births: 0, suddenDeaths: 0, persistenceDeaths: 0, mutations: 0, switchFlips: 0,
      maintainedConnections: 0, connectionMaintenancePaid: 0,
      foodProduced: 0, foodConsumed: 0, foodRecycled: 0,
      activities: ACTIVITIES.map(() => ({selected: 0, attempted: 0, succeeded: 0})),
      decisionCount: 0, meanDecisionInputs: null, decisionEnergySD: null,
      meanDecisionProbabilities: ACTIVITIES.map(() => null),
    };
  }

  function entityState(entity, enabled, tick) {
    const connectionSwitches = entity.genes.filter((_, i) => i % COEFFICIENTS.length !== 0)
      .map(weight => weight !== null);
    return {
      id: entity.id, parentId: entity.parentId, founderId: entity.founderId,
      generation: entity.generation, born: entity.born, cell: entity.cell,
      mass: entity.mass, surface: entity.surface, energy: entity.energy, waste: entity.waste,
      coefficients: entity.genes.slice(), connectionSwitches,
      activeConnections: connectionSwitches.filter(Boolean).length,
      effectiveActiveConnections: enabledConnectionCount(entity.genes, enabled),
      lastDecisionTick: entity.lastDecisionProbabilities ? tick : null,
      lastDecisionProbabilities: entity.lastDecisionProbabilities
        ? Array.from(entity.lastDecisionProbabilities) : null,
    };
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function inRange(value, min = 0, max = Infinity) {
    return Number.isFinite(value) && value >= min && value <= max;
  }

  function isCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isProbability(value) {
    return value === null || inRange(value, 0, 1);
  }

  function isList(values, size, check) {
    return Array.isArray(values) && values.length === size && values.every(check);
  }

  function savedOptions(values, defaults, label) {
    if (!isRecord(values)) throw new Error("Invalid " + label + " in the run file.");
    const result = {};
    for (const key of Object.keys(defaults)) {
      if (!Object.hasOwn(values, key)) continue;
      const value = values[key];
      if (typeof value !== typeof defaults[key] || (typeof value === "number" && !Number.isFinite(value))) {
        throw new Error("Invalid " + label + " in the run file.");
      }
      result[key] = value;
    }
    return result;
  }

  function savedParameters(values) {
    const params = savedOptions(values, DEFAULT_PARAMS, "model parameters");
    const fractions = ["suddenDeath", "mutationRate", "switchMutationRate", "failedAttemptFraction",
      "growthFraction", "shrinkFraction", "divisionLoss"];
    if (Object.values(params).some(value => typeof value === "number" && value < 0)
      || fractions.some(key => params[key] > 1)
      || params.offspringShare <= 0 || params.offspringShare >= 1
      || params.energyPerFood <= 0 || params.energyWasteRatio <= 0
      || params.mutationSharpness <= 0 || params.mutationTail <= 1) {
      throw new Error("A model parameter in the run file is out of range.");
    }
    return params;
  }

  function savedGeneSwitches(values) {
    return savedOptions(values, DEFAULT_SETUP.startingGeneSwitches, "gene switches");
  }

  function savedPlayback(playback) {
    if (playback == null) return undefined;
    const {speed, refresh, pauseAtTick} = playback;
    if (!SPEEDS.includes(speed) || !REFRESHES.includes(refresh) || !isCount(pauseAtTick)) {
      throw new Error("Invalid playback settings in the run file.");
    }
    return {speed, refresh, pauseAtTick};
  }

  function validateSavedHistory(history, tick) {
    if (!Array.isArray(history) || history.length !== tick + 1 || history.some((row, index) =>
      row?.tick !== index || !Array.isArray(row.excludedActivities)
      || row.excludedActivities.some(name => !ACTIVITIES.includes(name)))) {
      throw new Error("The run file has missing or invalid tick history.");
    }
    const geneCount = ACTIVITIES.length * COEFFICIENTS.length;
    for (const row of history.slice(-CHART_WINDOW)) {
      if (!isCount(row.population) || ![row.food, row.energy, row.waste].every(value => inRange(value))
        || !isList(row.genes, geneCount, gene => isList(gene, 4, value => value === null || Number.isFinite(value)))
        || !isList(row.meanDecisionProbabilities, ACTIVITIES.length, isProbability)
        || !isList(row.connectionOnFractions, CONNECTIONS.length, isProbability)
        || !isCount(row.distinctPatterns) || !(row.effectivePatterns === null || inRange(row.effectivePatterns))
        || !isProbability(row.dominantPatternShare)) {
        throw new Error("The run file has invalid chart data.");
      }
    }
    const last = history.at(-1);
    const inputs = last.meanDecisionInputs;
    if (inputs != null && (!isRecord(inputs) || ![inputs.mass, inputs.energy, inputs.waste].every(value => inRange(value)))) {
      throw new Error("The run file has invalid decision inputs.");
    }
    if (last.decisionEnergySD != null && (!inputs || !inRange(last.decisionEnergySD))) {
      throw new Error("The run file has an invalid decision energy spread.");
    }
    const counts = ["births", "suddenDeaths", "persistenceDeaths", "mutations", "switchFlips"];
    const stocks = ["mass", "energyCapacity", "wasteCapacity", "foodProduced", "foodConsumed",
      "foodRecycled", "connectionMaintenancePaid"];
    const latestCounts = ["generation", "peakPopulation", "lifespanSamples", "decisionCount", "leadingPatternCount",
      "maintainedConnections", "activeConnections", "effectiveActiveConnections"];
    if (!counts.every(key => isCount(last.totals?.[key]) && isCount(last[key]))
      || !stocks.every(key => inRange(last[key])) || !latestCounts.every(key => isCount(last[key]))
      || !(last.meanLifespan === null || inRange(last.meanLifespan))
      || !(last.leadingPattern === null && last.leadingPatternCount !== 1
        || typeof last.leadingPattern === "string" && /^[01]+$/.test(last.leadingPattern)
          && last.leadingPattern.length === CONNECTIONS.length)
      || !isList(last.connectionHistogram, CONNECTIONS.length + 1, isCount)
      || !["negative", "zero", "positive"].every(sign => isList(last.weightSigns?.[sign], CONNECTIONS.length, isCount))
      || !isList(last.activities, ACTIVITIES.length, activity =>
        isCount(activity?.selected) && isCount(activity.attempted) && isCount(activity.succeeded))) {
      throw new Error("The run file has invalid final readings.");
    }
    return last;
  }

  function restoreEntities(saved, simulation) {
    const ids = new Set();
    return saved.map(entity => {
      const {id, cell, mass, energy, waste, parentId, founderId, generation, born, coefficients, lastDecisionProbabilities}
        = entity ?? {};
      if (!isCount(id) || id === 0 || ids.has(id)
        || !isCount(cell) || cell >= simulation.cells.length
        || ![mass, energy, waste].every(value => inRange(value)) || mass < simulation.minMass
        || !(parentId === null || isCount(parentId) && parentId > 0 && parentId < id)
        || !isCount(founderId) || !founderId || founderId > id
        || !isCount(generation) || !isCount(born) || born > simulation.tick
        || !isList(coefficients, ACTIVITIES.length * COEFFICIENTS.length, (value, i) =>
          Number.isFinite(value) || value === null && i % COEFFICIENTS.length !== 0)
        || !(lastDecisionProbabilities === null || isList(lastDecisionProbabilities, ACTIVITIES.length, isProbability))) {
        throw new Error("The run file contains an invalid entity.");
      }
      ids.add(id);
      return {
        id, cell, mass, energy, waste, parentId, founderId, generation, born,
        surface: circumference(mass), genes: coefficients, lastDecisionProbabilities, demand: 0, plan: [],
      };
    });
  }

  class Simulation {
    constructor({setup = {}, params = {}, entropy = target => globalThis.crypto.getRandomValues(target), seed} = {}) {
      this.params = {...DEFAULT_PARAMS, ...params};
      this.setup = {...DEFAULT_SETUP, ...setup};
      this.setup.startingGeneSwitches = {...DEFAULT_SETUP.startingGeneSwitches, ...setup.startingGeneSwitches};
      this.appliedGeneSwitches = {...this.setup.startingGeneSwitches};
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
      this.geneSwitchChanges = [];
      this.pendingParameters = null;
      this.pendingGeneSwitches = null;
      this.totals = {births: 0, suddenDeaths: 0, persistenceDeaths: 0, mutations: 0, switchFlips: 0};
      this.recentLifespans = [];
      this.lifespanSum = 0;
      this.nextLifespanIndex = 0;
      this.peakPopulation = this.setup.founders;
      this.stats = tickStats();
      this.initialParams = {...this.params};
      this.makeFounders();
      this.record();
    }

    static fromResults(data, {entropy} = {}) {
      if (data?.model !== "Petri Dish") throw new Error("Choose a Petri Dish results file.");
      const checkpoint = data.checkpoint;
      if (checkpoint === undefined ? !["0.3", "0.3-dev", "0.4"].includes(data.version) : checkpoint?.format !== 1) {
        throw new Error("This version of the run file is unsupported.");
      }
      if (!isCount(data.tick) || !inRange(data.minimumMass) || data.minimumMass <= 0
        || !isList(data.activityOrder, ACTIVITIES.length, (name, i) => name === ACTIVITIES[i])
        || !isList(data.coefficientOrder, COEFFICIENTS.length, (name, i) => name === COEFFICIENTS[i])) {
        throw new Error("The run file has invalid model data.");
      }
      // Preserve the previous defaults for older files that omit settings.
      const {startingGeneSwitches = {}, ...savedSetup} = savedOptions(data.setup, DEFAULT_SETUP, "initial setup");
      const switches = savedGeneSwitches(startingGeneSwitches);
      const setup = {
        ...DEFAULT_SETUP, weightRange: 0.01, ...savedSetup,
        startingGeneSwitches: Object.fromEntries(CONNECTIONS.map(({key}) => [key, switches[key] ?? true])),
      };
      if (!isCount(setup.radius) || setup.radius > 30
        || !isCount(setup.founders) || setup.founders > 1 + 3 * setup.radius * (setup.radius + 1)
        || setup.initialMass <= 0 || setup.biasLow > setup.biasHigh
        || [setup.initialEnergy, setup.initialWaste, setup.initialFood, setup.weightRange].some(value => value < 0)) {
        throw new Error("The run file has an invalid initial setup.");
      }
      const defaults = {...DEFAULT_PARAMS, suddenDeath: 0.002, switchMutationRate: 0.001, failedAttemptFraction: 0};
      const params = {...defaults, ...savedParameters(data.appliedParameters)};
      const initialParams = {...defaults, ...savedParameters(data.initialParameters)};
      if (!Array.isArray(data.parameterChanges) || !Array.isArray(data.geneSwitchChanges)) {
        throw new Error("The run file is missing its parameter or gene switch history.");
      }
      const validateChange = change => {
        if (!isCount(change?.tick) || change.tick < 1 || change.tick > data.tick) {
          throw new Error("The run file contains an invalid settings change.");
        }
      };
      const parameterChanges = data.parameterChanges.map(change => {
        validateChange(change);
        return {tick: change.tick, values: savedParameters(change.values)};
      });
      const geneSwitchChanges = data.geneSwitchChanges.map(change => {
        validateChange(change);
        return {...change, values: savedGeneSwitches(change.values)};
      });
      const last = validateSavedHistory(data.history, data.tick);
      if (!Array.isArray(data.entities) || data.entities.length !== last.population) {
        throw new Error("The saved population does not match the tick history.");
      }
      if (checkpoint && !isList(checkpoint.globalSeed, 4, word => isCount(word) && word < UINT32)) {
        throw new Error("The run file contains an invalid seed.");
      }
      const simulation = new Simulation({
        setup: {...setup, founders: 0, initialFood: 0}, params, seed: checkpoint?.globalSeed, entropy,
      });
      if (!isList(data.cells, simulation.cells.length, (cell, i) =>
        cell?.q === simulation.cells[i].q && cell.r === simulation.cells[i].r && inRange(cell.food))) {
        throw new Error("The saved hexes do not match the dish.");
      }
      data.cells.forEach(({food}, i) => { simulation.cells[i].food = food; });
      Object.assign(simulation, {
        setup, minMass: data.minimumMass, tick: data.tick, initialParams, parameterChanges, geneSwitchChanges,
        history: data.history, peakPopulation: last.peakPopulation,
        appliedGeneSwitches: {...setup.startingGeneSwitches, ...savedGeneSwitches(data.appliedGeneSwitches)},
      });
      simulation.queueParameters(checkpoint?.pendingParameters ?? {});
      simulation.queueGeneSwitches(checkpoint?.pendingGeneSwitches ?? {});
      for (const key of Object.keys(simulation.totals)) simulation.totals[key] = last.totals[key];
      for (const key of Object.keys(simulation.stats)) simulation.stats[key] = last[key];
      simulation.entities = restoreEntities(data.entities, simulation);

      // Earlier results files identify every founder and birth but contain no individual lifespans.
      const nextId = checkpoint?.nextId ?? setup.founders + last.totals.births + 1;
      if (!isCount(nextId) || nextId < 1 || simulation.entities.some(entity => entity.id >= nextId)) {
        throw new Error("The saved entity numbering is invalid.");
      }
      simulation.nextId = nextId;
      if (checkpoint) {
        const {recentLifespans, lifespanSum, nextLifespanIndex} = checkpoint;
        if (!Array.isArray(recentLifespans) || recentLifespans.length > LIFESPAN_WINDOW
          || recentLifespans.some(age => !isCount(age) || age > data.tick)
          || !inRange(lifespanSum) || !isCount(nextLifespanIndex)
          || nextLifespanIndex >= LIFESPAN_WINDOW
          || recentLifespans.length < LIFESPAN_WINDOW && nextLifespanIndex !== recentLifespans.length) {
          throw new Error("The run file contains invalid lifespan data.");
        }
        Object.assign(simulation, {recentLifespans, lifespanSum, nextLifespanIndex});
      }
      return simulation;
    }

    makeFounders() {
      const {founders, initialMass, initialEnergy, initialWaste, biasLow, biasHigh, weightRange} = this.setup;
      const places = this.cells.map((_, index) => index);
      const energy = Math.min(initialEnergy, initialMass * this.params.energyCapacity);
      const waste = Math.min(initialWaste, initialMass * this.params.wasteCapacity);
      for (let i = 0; i < founders; i++) {
        const chosen = i + Math.floor(this.random.unit() * (places.length - i));
        [places[i], places[chosen]] = [places[chosen], places[i]];
        const genes = new Array(ACTIVITIES.length * COEFFICIENTS.length);
        for (let offset = 0; offset < genes.length; offset += COEFFICIENTS.length) {
          genes[offset] = biasLow + this.random.unit() * (biasHigh - biasLow);
          for (let weight = 1; weight < COEFFICIENTS.length; weight++) {
            const index = offset + weight;
            // Keep positions, biases and unrelated weights stable while editing the seeded preview.
            const drawn = initialWeight(weightRange, this.random);
            genes[index] = this.setup.startingGeneSwitches[CONNECTIONS[INPUT_AT[index]].key] ? drawn : null;
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

    enabledActivities() {
      return ACTIVITY_ENABLED_KEYS.map(key => this.params[key]);
    }

    // Edits made between ticks are part of a checkpoint until the next step.
    queueParameters(changes) {
      const values = savedParameters(changes);
      if (Object.keys(values).length) this.pendingParameters = {...this.pendingParameters, ...values};
    }

    queueGeneSwitches(changes) {
      const values = savedGeneSwitches(changes);
      if (Object.keys(values).length) this.pendingGeneSwitches = {...this.pendingGeneSwitches, ...values};
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

    resetGeneSwitches(settings) {
      const targets = CONNECTIONS.filter(({key}) => typeof settings[key] === "boolean");
      if (!targets.length) return;
      const values = {};
      let weightsDrawn = 0;
      let weightsRemoved = 0;
      for (const {key, coefficient} of targets) {
        const on = settings[key];
        values[key] = on;
        this.appliedGeneSwitches[key] = on;
        for (const entity of this.entities) {
          if (on) {
            entity.genes[coefficient] = initialWeight(this.setup.weightRange, this.random);
            weightsDrawn++;
          } else {
            if (entity.genes[coefficient] !== null) weightsRemoved++;
            entity.genes[coefficient] = null;
          }
        }
      }
      this.geneSwitchChanges.push({tick: this.tick, values, population: this.entities.length, weightsDrawn, weightsRemoved});
    }

    recordDeath(entity) {
      const lifespan = this.tick - entity.born;
      const index = this.nextLifespanIndex;
      this.lifespanSum += lifespan - (this.recentLifespans[index] ?? 0);
      this.recentLifespans[index] = lifespan;
      this.nextLifespanIndex = (index + 1) % LIFESPAN_WINDOW;
      this.cells[entity.cell].released += entity.mass;
    }

    step(geneSwitchResets) {
      if (this.pendingParameters) {
        this.applyParameters(this.pendingParameters);
        this.pendingParameters = null;
      }
      if (this.pendingGeneSwitches) {
        geneSwitchResets = {...this.pendingGeneSwitches, ...geneSwitchResets};
        this.pendingGeneSwitches = null;
      }
      this.tick++;
      this.entropy(this.tickSalt);
      this.random.reseed(this.globalSeed, this.tickSalt);
      this.stats = tickStats();
      if (geneSwitchResets) this.resetGeneSwitches(geneSwitchResets);
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
      const enabled = this.enabledActivities();
      for (const entity of feeding) {
        const connections = enabledConnectionCount(entity.genes, enabled);
        const upkeep = this.params.connectionCost * connections;
        const cost = this.params.persistence * entity.mass + upkeep;
        if (entity.energy < cost) {
          this.stats.persistenceDeaths++;
          this.recordDeath(entity);
        } else {
          entity.energy -= cost;
          this.stats.maintainedConnections += connections;
          this.stats.connectionMaintenancePaid += upkeep;
          this.entities.push(entity);
        }
      }

      // 5. Decisions use the same pre-execution state within each entity.
      const anyEnabled = enabled.some(Boolean);
      let decisionCount = 0;
      const meanDecisionInputs = {mass: 0, energy: 0, waste: 0};
      let energyScale = 0;
      let energySquaredDeviations = 0;
      const probabilitySums = new Float64Array(ACTIVITIES.length);
      for (const entity of this.entities) {
        entity.plan.length = 0;
        if (!anyEnabled) {
          entity.lastDecisionProbabilities = null;
          continue;
        }
        decisionCount++;
        const share = 1 / decisionCount;
        // Scale the running sum of squared deviations to keep large energies finite.
        const energy = entity.energy;
        if (energy > energyScale) {
          energySquaredDeviations *= (energyScale / energy) ** 2;
          energyScale = energy;
        }
        const energyDelta = energy - meanDecisionInputs.energy;
        const scaledDelta = energyDelta / (energyScale || 1);
        energySquaredDeviations += scaledDelta ** 2 * (1 - share);
        meanDecisionInputs.mass += (entity.mass - meanDecisionInputs.mass) * share;
        meanDecisionInputs.energy += energyDelta * share;
        meanDecisionInputs.waste += (entity.waste - meanDecisionInputs.waste) * share;
        const probabilities = entity.lastDecisionProbabilities ??= new Array(ACTIVITIES.length);
        for (let activity = 0; activity < ACTIVITIES.length; activity++) {
          if (!enabled[activity]) {
            probabilities[activity] = null;
            continue;
          }
          const logit = dotProduct(entity, activity * COEFFICIENTS.length);
          const rareOdds = Math.exp(-Math.abs(logit));
          const probability = sigmoid(logit, rareOdds);
          probabilities[activity] = probability;
          probabilitySums[activity] += probability;
          if (!chooseActivity(logit, this.random, rareOdds)) continue;
          entity.plan.push({activity, logit, tie: this.random.unit()});
          this.stats.activities[activity].selected++;
        }
        entity.plan.sort((a, b) => a.logit === b.logit ? a.tie - b.tie : (a.logit > b.logit ? -1 : 1));
      }
      this.stats.decisionCount = decisionCount;
      if (decisionCount) {
        this.stats.meanDecisionInputs = meanDecisionInputs;
        this.stats.decisionEnergySD = energyScale * Math.sqrt(energySquaredDeviations / decisionCount);
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
      return this.record(enabled);
    }

    failAttempt(entity, referenceEnergy) {
      const fraction = this.params.failedAttemptFraction;
      if (fraction > 0) entity.energy -= Math.min(entity.energy, fraction * referenceEnergy);
      return false;
    }

    execute(activity, entity, newborns) {
      const params = this.params;
      switch (activity) {
        case 0: {
          const removable = Math.min(entity.waste, entity.surface * params.excretionRate);
          const affordable = params.excretionCost === 0 ? Infinity : entity.energy / params.excretionCost;
          const amount = Math.min(removable, affordable);
          if (amount <= 0) return this.failAttempt(entity, removable * params.excretionCost);
          entity.energy = Math.max(0, entity.energy - amount * params.excretionCost);
          entity.waste -= amount;
          return true;
        }
        case 1: {
          const added = entity.mass * params.growthFraction;
          const mass = entity.mass + added;
          const cost = added * params.foodPerMass * params.energyPerFood * (1 + params.growthSpread);
          if (mass === entity.mass || entity.energy < cost) return this.failAttempt(entity, cost);
          if (!Number.isFinite(mass)) throw new RangeError("A simulated mass exceeded the numerical range.");
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
            || !fits(energy, mass * params.energyCapacity) || !fits(waste, mass * params.wasteCapacity)) {
            return this.failAttempt(entity, gainedEnergy);
          }
          entity.mass = mass;
          entity.surface = circumference(mass);
          entity.energy = energy;
          entity.waste = waste;
          return true;
        }
        case 3: {
          const cost = entity.mass * params.movementCost;
          const neighbors = this.cells[entity.cell].neighbors;
          if (!neighbors.length || entity.energy < cost) return this.failAttempt(entity, cost);
          entity.cell = neighbors[Math.floor(this.random.unit() * neighbors.length)];
          entity.energy -= cost;
          return true;
        }
        case 4:
          if (this.reproduce(entity, newborns)) return true;
          return this.failAttempt(entity, params.reproductionCost);
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
      const {mutationRate, mutationWidth, switchMutationRate} = this.params;
      const mutateNumbers = mutationRate > 0 && mutationWidth > 0;
      if (!mutateNumbers && switchMutationRate === 0) return genes;
      for (let activity = 0; activity < ACTIVITIES.length; activity++) {
        if (!this.params[ACTIVITY_ENABLED_KEYS[activity]]) continue;
        for (let j = 0; j < COEFFICIENTS.length; j++) {
          const i = activity * COEFFICIENTS.length + j;
          if (j !== 0 && switchMutationRate > 0 && this.random.unit() < switchMutationRate) {
            genes[i] = original[i] === null ? initialWeight(this.setup.weightRange, this.random) : null;
            this.stats.switchFlips++;
            continue;
          }
          if (genes[i] === null || !mutateNumbers || this.random.unit() >= mutationRate) continue;
          const mutated = mutateValue(genes[i], this.params, this.random);
          if (mutated !== genes[i]) this.stats.mutations++;
          genes[i] = mutated;
        }
      }
      return genes;
    }

    record(enabled = this.enabledActivities()) {
      const population = this.entities.length;
      const geneLength = ACTIVITIES.length * COEFFICIENTS.length;
      const genes = Array.from({length: geneLength}, () => [0, 0, Infinity, -Infinity]);
      const scales = new Float64Array(geneLength);
      const sampleCounts = new Array(geneLength).fill(0);
      const patternCounts = new Map();
      const connectionHistogram = new Array(CONNECTIONS.length + 1).fill(0);
      const weightSigns = {
        negative: new Array(CONNECTIONS.length).fill(0),
        zero: new Array(CONNECTIONS.length).fill(0),
        positive: new Array(CONNECTIONS.length).fill(0),
      };
      let energy = 0;
      let waste = 0;
      let mass = 0;
      let generation = 0;
      for (const entity of this.entities) {
        energy += entity.energy;
        waste += entity.waste;
        mass += entity.mass;
        generation = Math.max(generation, entity.generation);
        let pattern = NUMERIC_PATTERN ? 0 : "";
        let stored = 0;
        for (let i = 0; i < geneLength; i++) {
          const value = entity.genes[i];
          const input = INPUT_AT[i];
          if (input !== -1) {
            const bit = value === null ? 0 : 1;
            pattern = NUMERIC_PATTERN ? pattern * 2 + bit : pattern + bit;
            if (value !== null) {
              stored++;
              if (value > 0) weightSigns.positive[input]++;
              else if (value < 0) weightSigns.negative[input]++;
              else weightSigns.zero[input]++;
            }
          }
          if (value === null) continue;
          const count = ++sampleCounts[i];
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
        connectionHistogram[stored]++;
        patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
      }
      let sumSquares = 0;
      let largestPattern = 0;
      let leadingPattern = null;
      let leadingPatternCount = 0;
      for (const [pattern, count] of patternCounts) {
        sumSquares += count * count;
        if (count > largestPattern) {
          largestPattern = count;
          leadingPattern = pattern;
          leadingPatternCount = 1;
        } else if (count === largestPattern) {
          leadingPatternCount++;
          leadingPattern = null;
        }
      }
      if (leadingPattern !== null && NUMERIC_PATTERN) {
        leadingPattern = leadingPattern.toString(2).padStart(CONNECTIONS.length, "0");
      }
      const connectionOnFractions = [];
      let activeConnections = 0;
      let effectiveActiveConnections = 0;
      for (let i = 0; i < geneLength; i++) {
        const distribution = genes[i];
        const count = sampleCounts[i];
        if (i % COEFFICIENTS.length !== 0) {
          connectionOnFractions.push(population ? count / population : null);
          activeConnections += count;
          if (enabled[Math.floor(i / COEFFICIENTS.length)]) effectiveActiveConnections += count;
        }
        if (count) {
          distribution[0] *= scales[i];
          distribution[1] = Math.sqrt(Math.min(1, Math.max(0, distribution[1]) / count)) * scales[i];
        } else {
          distribution.fill(null);
        }
      }
      const food = this.cells.reduce((total, cell) => total + cell.food, 0);
      const energyCapacity = mass * this.params.energyCapacity;
      const wasteCapacity = mass * this.params.wasteCapacity;
      if (![mass, energy, waste, food, energyCapacity, wasteCapacity].every(Number.isFinite)) {
        throw new RangeError("A simulated stock exceeded the numerical range.");
      }

      const lifespanSamples = this.recentLifespans.length;
      const result = {
        tick: this.tick, population, food, mass, energy, waste, generation, genes,
        activeConnections, effectiveActiveConnections, connectionOnFractions,
        connectionHistogram, weightSigns,
        distinctPatterns: patternCounts.size, effectivePatterns: population ? population * population / sumSquares : null,
        dominantPatternShare: population ? largestPattern / population : null,
        leadingPattern, leadingPatternCount,
        geneSwitchReset: this.geneSwitchChanges.at(-1)?.tick === this.tick,
        excludedActivities: ACTIVITIES.filter((_, i) => !enabled[i]),
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
        entity: selected ? entityState(selected, this.enabledActivities(), this.tick) : null,
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
      const enabled = this.enabledActivities();
      return {
        model: "Petri Dish", version: VERSION, tick: this.tick, minimumMass: this.minMass,
        setup: this.setup, initialParameters: this.initialParams, appliedParameters: {...this.params},
        appliedGeneSwitches: {...this.appliedGeneSwitches}, geneSwitchChanges: this.geneSwitchChanges,
        parameterChanges: this.parameterChanges, activityOrder: ACTIVITIES, coefficientOrder: COEFFICIENTS,
        connectionInputOrder: COEFFICIENTS.slice(1),
        genetics: {
          connectionOrder: "Activity order, then connection input order. An OFF weight is null.",
          activationDistribution: "Uniform from -setup.weightRange to +setup.weightRange",
          geneSwitchChanges: "Manual resets apply at the start of the listed tick to every then-living entity. ON draws a fresh weight, OFF removes it. Subsequent inheritance can change either state.",
          patterns: "Distinct sets of stored ON inputs, including those in excluded activities. Numeric weight and bias values do not affect pattern identity.",
          effectivePatterns: "Inverse Simpson diversity (one divided by the sum of squared pattern frequencies)",
          dominantPatternShare: "Fraction of living entities carrying the most frequent stored switch pattern",
          leadingPattern: "ON/OFF bit string in connection order when there is one most frequent pattern. leadingPatternCount reports ties.",
          connectionHistogram: "Each bin counts living entities with that many stored ON inputs",
          weightSigns: "Counts among living carriers for each input, in connection order. An ON weight of zero counts as zero.",
          mutations: "Numerical changes to copied biases and surviving ON weights",
          switchFlips: "Inherited switches that changed state, including newly created weights",
          activeConnections: "Stored ON inputs at the end of the tick, including newborns",
          effectiveActiveConnections: "Stored ON inputs in enabled activities at the end of the tick",
          maintainedConnections: "Effective ON inputs of entities that paid persistence, before decisions and reproduction",
          connectionMaintenancePaid: "Total energy paid for effective ON inputs at the persistence stage of this tick",
          meanDecisionInputs: "Mean mass, energy and waste of the entities making decisions, after persistence and before optional activities",
          decisionEnergySD: "Population standard deviation of energy among those same entities at the decision stage",
        },
        coefficientStatistics: ["mean", "populationStandardDeviation", "minimum", "maximum"],
        history: this.history, entities: this.entities.map(entity => entityState(entity, enabled, this.tick)),
        cells: this.cells.map(({q, r, food}) => ({q, r, food})),
        checkpoint: {
          format: 1, globalSeed: Array.from(this.globalSeed), nextId: this.nextId,
          pendingParameters: {...this.pendingParameters}, pendingGeneSwitches: {...this.pendingGeneSwitches},
          recentLifespans: this.recentLifespans.slice(), lifespanSum: this.lifespanSum, nextLifespanIndex: this.nextLifespanIndex,
        },
      };
    }
  }

  return {
    VERSION,
    Simulation, ACTIVITIES, ACTIVITY_ENABLED_KEYS, COEFFICIENTS, GENE_TREE, DEFAULT_SETUP, DEFAULT_PARAMS, DEFAULT_PAUSE_TICK,
    SPEEDS, REFRESHES, CHART_WINDOW, SUCCESS_RATE_AVERAGE_TICKS, savedParameters, savedGeneSwitches, savedPlayback,
    Random, feedCell, foodIncome, mutateValue, sigmoid, dotProduct, chooseActivity, circumference,
  };
})();

if (typeof module === "object" && module.exports) module.exports = Petri;
