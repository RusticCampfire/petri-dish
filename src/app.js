"use strict";

const {ACTIVITIES, ACTIVITY_ENABLED_KEYS, COEFFICIENTS, DEFAULT_SETUP, DEFAULT_PARAMS, DEFAULT_PAUSE_TICK} = CONFIG;
const SPEEDS = [1, 5, 10, 25, 50, 100, 250, 0];
const REFRESHES = [0, 100, 500, 1000, 2000, 5000, 10000];
const CHART_WINDOW = 5000;
const DEFAULT_MODEL_PARAMS = Object.fromEntries(
  Object.entries(DEFAULT_PARAMS).filter(([key]) => !ACTIVITY_ENABLED_KEYS.includes(key)),
);
const MODEL_PRESETS = {
  default: DEFAULT_MODEL_PARAMS,
  "scarce-food": {...DEFAULT_MODEL_PARAMS, foodMean: 1.5, foodSD: 8},
};
const $ = id => document.getElementById(id);
const all = selector => Array.from(document.querySelectorAll(selector));
const write = (id, value) => { $(id).textContent = value; };
const int = new Intl.NumberFormat("en", {maximumFractionDigits: 0});
const dec = new Intl.NumberFormat("en", {maximumFractionDigits: 2});
const percent = new Intl.NumberFormat("en", {style: "percent", maximumFractionDigits: 2});
const compact = new Intl.NumberFormat("en", {notation: "compact", maximumFractionDigits: 1});
const exact = value => value === 0 ? "0" : value.toPrecision(3);
const controls = new Map();

const GROUPS = [
  ["Environment", true, [
    ["foodMean", "Food income", "F/hex", 0, 12, 0.1],
    ["foodSD", "Food deviation", "F/hex", 0, 8, 0.05],
    ["suddenDeath", "Sudden death", "%/tick", 0, 5, 0.01, {scale: 100, max: 100}],
  ]],
  ["Metabolism", false, [
    ["intake", "Food intake", "F/S", 0, 2, 0.01],
    ["energyPerFood", "Energy per food", "E/F", 0.01, 6, 0.01, {min: 0.000001}],
    ["energyWasteRatio", "Energy-to-waste ratio", "E/W", 0.01, 10, 0.05, {min: 0.000001}],
    ["foodPerMass", "Food per mass", "F/M", 0, 6, 0.05],
    ["energyCapacity", "Energy capacity", "E/M", 0, 16, 0.1],
    ["wasteCapacity", "Waste capacity", "W/M", 0, 10, 0.1],
    ["persistence", "Persistence cost", "E/M", 0, 1, 0.005],
    ["excretionRate", "Excretion rate", "W/S", 0, 4, 0.05],
    ["excretionCost", "Excretion cost", "E/W", 0, 0.5, 0.005],
  ]],
  ["Growth, movement & division", false, [
    ["growthFraction", "Mass growth", "%", 0, 100, 1, {scale: 100, max: 100}],
    ["shrinkFraction", "Mass shrinking", "%", 0, 100, 1, {scale: 100, max: 100}],
    ["growthSpread", "Growth spread", "%", 0, 100, 1, {scale: 100}],
    ["movementCost", "Movement cost", "E/M", 0, 0.5, 0.005],
    ["reproductionCost", "Reproduction cost", "E", 0, 12, 0.1],
    ["divisionLoss", "Division mass loss", "%", 0, 100, 1, {scale: 100, max: 100}],
    ["offspringShare", "Offspring share", "%", 1, 99, 1, {scale: 100, min: 0.01, max: 99.99}],
  ]],
  ["Inheritance", false, [
    ["mutationRate", "Mutation chance", "%", 0, 20, 0.1, {scale: 100, max: 100}],
    ["mutationWidth", "Peak width", "", 0, 1, 0.01],
    ["mutationSharpness", "Edge sharpness", "", 0.1, 32, 0.1, {max: 1000}],
    ["mutationTail", "Tail exponent", "", 1.01, 10, 0.01, {max: 1000}],
    ["mutateParent", "Mutate original pattern", "toggle"],
  ]],
];

const SETUP_KNOBS = [
  ["radius", "Dish radius", "hexes", 0, 30, 1, {max: 30, integral: true}],
  ["founders", "Founders", "", 0, 91, 1, {max: 91, integral: true}],
  ["initialMass", "Founder mass", "M", 0.01, 40, 0.01, {min: 0.000001}],
  ["initialEnergy", "Founder energy", "E", 0, 80, 1],
  ["initialWaste", "Founder waste", "W", 0, 40, 1],
  ["initialFood", "Starting food", "F/hex", 0, 20, 0.25],
  ["biasLow", "Bias lower bound", "", -12, 12, 0.1, {min: -1000000}],
  ["biasHigh", "Bias upper bound", "", -12, 12, 0.1, {min: -1000000}],
  ["weightRange", "Weight range ±", "", 0, 0.1, 0.001],
];

let worker;
let runId = 0;
let ready = false;
let running = false;
let commandPending = false;
let setupLocked = false;
let failed = false;
let checkpoint = false;
let pauseAtTick = DEFAULT_PAUSE_TICK;
let setup = {...DEFAULT_SETUP};
let params = {...DEFAULT_PARAMS};
let appliedParams = {};
let snapshot = null;
let history = [];
let lastFrame = 0;
let watch = {cell: 45, entityId: null, token: 0};
let hoverCell = -1;
let hexPositions = [];
let hexSize = 0;
let inspector = null;
let inspectedAt = 0;
let chart = "genetics";
let occupantOptions = "";
let lastLegend = "";

function post(type, details = {}) {
  if (worker) worker.postMessage({type, runId, ...details});
}

function rangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  input.style.setProperty("--fill", ((input.valueAsNumber - min) / (max - min) * 100 || 0) + "%");
}

function makeKnob(spec, values, kind) {
  const [key, name, unit, sliderMin, sliderMax, step, options = {}] = spec;
  const {scale = 1, min = sliderMin, max = 1000000, integral = false} = options;
  const id = "param-" + key;
  const el = document.createElement("div");
  if (unit === "toggle") {
    el.innerHTML = '<label class="knob-check"><input type="checkbox"> <span></span></label>';
    const checkbox = el.querySelector("input");
    checkbox.id = id;
    checkbox.checked = values[key];
    el.querySelector("span").textContent = name;
    checkbox.addEventListener("change", () => setParameter(key, checkbox.checked, kind));
    controls.set(key, {sync: value => { checkbox.checked = value; }});
  } else {
    el.className = "knob";
    el.innerHTML = '<label><span></span><small class="unit"></small></label><input type="number"><input type="range">';
    const [number, range] = el.querySelectorAll("input");
    const label = el.querySelector("label");
    label.htmlFor = id;
    label.querySelector("span").textContent = name;
    label.querySelector("small").textContent = unit;
    if (!unit) label.querySelector("small").hidden = true;
    number.id = id;
    number.setAttribute("aria-label", unit ? name + " (" + unit + ")" : name);
    number.step = integral ? "1" : "any";
    number.min = min;
    number.max = max;
    range.min = sliderMin;
    range.max = sliderMax;
    range.step = step;
    range.setAttribute("aria-label", name + " slider");
    const sync = value => {
      number.value = String(Number((value * scale).toPrecision(12)));
      range.value = number.value;
      rangeFill(range);
    };
    range.addEventListener("input", () => setParameter(key, range.valueAsNumber / scale, kind));
    const commit = () => {
      if (!Number.isFinite(number.valueAsNumber)) {
        sync(valuesFor(kind)[key]);
        return;
      }
      let value = Math.max(Number(number.min), Math.min(Number(number.max), number.valueAsNumber));
      if (integral) value = Math.round(value);
      if ((key === "foodMean" || key === "foodSD") && value > 0) value = Math.max(value, 0.000001);
      if (value / scale === valuesFor(kind)[key]) sync(valuesFor(kind)[key]);
      else setParameter(key, value / scale, kind);
    };
    number.addEventListener("change", commit);
    number.addEventListener("blur", commit);
    number.addEventListener("keydown", event => { if (event.key === "Enter") commit(); });
    controls.set(key, {sync, number, range});
    sync(values[key]);
  }
  return el;
}

function valuesFor(kind) {
  return kind === "setup" ? setup : params;
}

function hexCount(radius) {
  return 1 + 3 * radius * (radius + 1);
}

function normalizeSetup() {
  const founders = controls.get("founders");
  const max = hexCount(setup.radius);
  founders.number.max = max;
  founders.range.max = Math.max(1, max);
  setup.founders = Math.min(setup.founders, max);
  const energy = controls.get("initialEnergy");
  const waste = controls.get("initialWaste");
  energy.number.max = Math.min(1000000, setup.initialMass * params.energyCapacity);
  waste.number.max = Math.min(1000000, setup.initialMass * params.wasteCapacity);
  energy.range.max = Math.max(1, Math.min(80, Number(energy.number.max)));
  waste.range.max = Math.max(1, Math.min(40, Number(waste.number.max)));
  setup.initialEnergy = Math.min(setup.initialEnergy, Number(energy.number.max));
  setup.initialWaste = Math.min(setup.initialWaste, Number(waste.number.max));
  founders.sync(setup.founders);
  energy.sync(setup.initialEnergy);
  waste.sync(setup.initialWaste);
  write("setup-minimum", dec.format(setup.initialMass * 0.01));
  if (setup.initialMass * 0.01 < 0.01) write("setup-minimum", exact(setup.initialMass * 0.01));
}

function setParameter(key, value, kind) {
  if (kind !== "setup") {
    setLiveParameters({[key]: value});
    return;
  }
  if (setupLocked) return;
  if (key === "initialEnergy" || key === "initialWaste" || key === "founders") {
    value = Math.min(value, Number(controls.get(key).number.max));
  }
  setup[key] = value;
  controls.get(key).sync(value);
  if (setup.biasLow > setup.biasHigh) {
    const other = key === "biasLow" ? "biasHigh" : "biasLow";
    setup[other] = value;
    controls.get(other).sync(value);
  }
  normalizeSetup();
  if (key === "radius") chooseCenter();
  post("setup", {setup, watch});
}

function setLiveParameters(values) {
  const changes = {};
  for (const [key, value] of Object.entries(values)) {
    if (params[key] === value) continue;
    params[key] = value;
    controls.get(key).sync(value);
    changes[key] = value;
  }
  if (!Object.keys(changes).length) return;
  if (!setupLocked && ("energyCapacity" in changes || "wasteCapacity" in changes)) {
    normalizeSetup();
    post("tune", {values: changes, setup});
  } else {
    post("tune", {values: changes});
  }
  const selected = Object.keys(MODEL_PRESETS).find(name =>
    Object.entries(MODEL_PRESETS[name]).every(([key, value]) => params[key] === value)
  );
  $("model-preset").value = selected ?? "";
  showPending();
}

function showPending() {
  $("pending-note").hidden = !setupLocked || Object.keys(params).every(key => params[key] === appliedParams[key]);
}

function mountControls() {
  for (const [name, open, knobs] of GROUPS) {
    const detail = document.createElement("details");
    detail.className = "parameter-group";
    detail.open = open;
    const summary = document.createElement("summary");
    summary.textContent = name;
    const content = document.createElement("div");
    content.className = "knobs";
    for (const knob of knobs) content.append(makeKnob(knob, params, "live"));
    detail.append(summary, content);
    $("runtime-controls").append(detail);
  }
  $("setup-controls").className = "knobs";
  for (const knob of SETUP_KNOBS) $("setup-controls").append(makeKnob(knob, setup, "setup"));
  const min = document.createElement("div");
  min.className = "derived";
  min.innerHTML = '<span>Minimum mass</span><output id="setup-minimum"></output>';
  $("setup-controls").append(min);
  normalizeSetup();

  for (let i = 0; i < ACTIVITIES.length; i++) {
    const el = document.createElement("div");
    el.className = "activity-row";
    el.innerHTML = '<span class="value"></span><span class="value"></span><span class="value"></span><span class="value success"></span>';
    const [probability, selected, attempted, done] = el.children;
    el.prepend(makeKnob([ACTIVITY_ENABLED_KEYS[i], ACTIVITIES[i], "toggle"], params, "live"));
    probability.id = "activity-probability-" + i;
    selected.id = "activity-selected-" + i;
    attempted.id = "activity-attempted-" + i;
    done.id = "activity-done-" + i;
    $("activity-list").append(el);
  }
  const historySelect = $("gene-select");
  for (const name of new Set(["Reproduction", "Movement", ...ACTIVITIES])) {
    const activity = ACTIVITIES.indexOf(name);
    const probability = new Option(name + " · Mean probability", "probability-" + activity);
    probability.dataset.probabilityActivity = String(activity);
    historySelect.add(probability);
    for (let j = 0; j < COEFFICIENTS.length; j++) {
      historySelect.add(new Option(name + " · " + COEFFICIENTS[j], activity * COEFFICIENTS.length + j));
    }
  }
  const reproduction = ACTIVITIES.indexOf("Reproduction");
  const bias = COEFFICIENTS.indexOf("Bias");
  historySelect.value = String(reproduction * COEFFICIENTS.length + bias);
  mountActivityTable("population-genes-table", [...COEFFICIENTS, "Mean probability"], "Population averages");
  mountActivityTable("entity-genes-table", ["Last probability", "Bias", "M", "E", "W"], "Decision coefficients");
}

function mountActivityTable(id, columns, name) {
  const table = document.createElement("table");
  table.className = "coefficient-table";
  table.setAttribute("aria-label", name);
  const head = table.createTHead().insertRow();
  for (const label of ["Activity", ...columns]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (let i = 0; i < ACTIVITIES.length; i++) {
    const row = body.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = ACTIVITIES[i];
    row.append(th);
    for (let j = 0; j < columns.length; j++) {
      const cell = row.insertCell();
      cell.id = id + "-" + i + "-" + j;
      cell.textContent = "—";
    }
  }
  $(id).append(table);
}

function formatProbability(value) {
  if (value === null) return "—";
  if (value < 0.0001) return "<0.01%";
  if (value > 0.9999) return ">99.99%";
  return percent.format(value);
}

function chooseCenter() {
  watch = {cell: (hexCount(setup.radius) - 1) / 2, entityId: null, token: watch.token + 1};
  inspector = null;
  hoverCell = -1;
}

function newRun() {
  runId++;
  lastFrame = 0;
  ready = false;
  running = false;
  failed = false;
  checkpoint = false;
  commandPending = false;
  snapshot = null;
  history = [];
  normalizeSetup();
  chooseCenter();
  renderStatus("loading", 0);
  post("reset", {setup, params, watch, speed: speedValue(), refresh: refreshValue(), pauseAtTick});
}

function renderStatus(reason, tick) {
  ready = reason !== "loading";
  checkpoint = reason === "checkpoint";
  failed = reason === "error";
  running = reason === "running";
  setupLocked = running || tick > 0 || failed || reason === "loading";
  const active = $("run-status");
  active.className = "status " + reason;
  write("run-status-text", {
    ready: "Ready", paused: "Paused", running: "Running",
    checkpoint: "Checkpoint", error: "Stopped", loading: "Loading",
  }[reason]);
  const tickRate = $("run-tick-rate");
  tickRate.hidden = !running;
  tickRate.textContent = running ? " (… ticks/s)" : "";
  $("play").disabled = !ready || failed || commandPending;
  $("step").disabled = !ready || running || failed || commandPending;
  $("restart").disabled = !ready;
  $("export").disabled = !ready || failed;
  $("play").lastElementChild.textContent = running ? "Pause" : tick > 0 ? "Resume" : "Start";
  $("play").firstElementChild.className = "icon " + (running ? "icon-pause" : "icon-play");
  $("setup-fields").disabled = setupLocked;
  write("setup-state", setupLocked ? "Locked until restart" : "New run");
  const notice = $("run-notice");
  notice.hidden = !checkpoint && !failed;
  notice.classList.toggle("error", failed);
  if (checkpoint) notice.textContent = "Paused at tick " + int.format(tick) + ". Resume to continue.";
  showPending();
}

function speedValue() { return SPEEDS[$("speed").valueAsNumber]; }
function refreshValue() { return REFRESHES[$("refresh").valueAsNumber]; }

function updateTiming() {
  rangeFill($("speed"));
  rangeFill($("refresh"));
  write("speed-value", speedValue() ? int.format(speedValue()) + " ticks/s" : "Max");
  write("refresh-value", refreshValue() ? dec.format(refreshValue() / 1000) + " s" : "Every tick");
  $("speed").setAttribute("aria-valuetext", $("speed-value").textContent);
  $("refresh").setAttribute("aria-valuetext", $("refresh-value").textContent);
  post("display", {speed: speedValue(), refresh: refreshValue()});
}

function presentFrame(data) {
  if (data.runId !== runId || data.frame < lastFrame) return;
  lastFrame = data.frame;
  snapshot = data.snapshot;
  appliedParams = data.params;
  if (data.watchToken === watch.token) {
    inspector = snapshot.inspect;
    inspectedAt = snapshot.tick;
  }
  renderGauges(data.summary, data.minimumMass);
  renderPopulationGenetics(data.summary);
  renderDish();
  renderInspector();
  renderHistory();
  showPending();
}

function receive({data}) {
  if (data.runId !== runId) return;
  switch (data.type) {
    case "status":
      commandPending = false;
      renderStatus(data.reason, data.tick);
      break;
    case "tick-rate":
      if (running) {
        const rate = data.ticksPerSecond;
        write("run-tick-rate", " (" + (rate < 10 ? dec : int).format(rate) + " ticks/s)");
      }
      break;
    case "frame":
      if (data.replaceHistory) {
        history = [];
      }
      for (const record of data.records) {
        history.push({
          tick: record.tick, population: record.population, food: record.food, energy: record.energy,
          waste: record.waste, genes: record.genes.map(([mean, sd]) => [mean, sd]),
          meanDecisionProbabilities: record.meanDecisionProbabilities,
        });
      }
      if (history.length > CHART_WINDOW) history.splice(0, history.length - CHART_WINDOW);
      if (data.debug && document.visibilityState === "visible") {
        requestAnimationFrame(() => {
          presentFrame(data);
          requestAnimationFrame(() => {
            if (data.runId === runId) post("painted", {frame: data.frame});
          });
        });
      } else {
        presentFrame(data);
        if (data.debug) post("painted", {frame: data.frame});
      }
      break;
    case "applied":
      appliedParams = data.params;
      showPending();
      break;
    case "inspector":
      if (data.watchToken !== watch.token) break;
      inspector = data.inspector;
      inspectedAt = data.tick;
      renderInspector();
      break;
    case "export":
      download(data.blob, "petri-dish-tick-" + data.tick + ".json");
      $("export").disabled = false;
      break;
    case "failure":
      $("run-notice").textContent = data.message + " Restart to begin a new run.";
      break;
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderGauges(summary, minimum) {
  write("tick", String(summary.tick).padStart(4, "0"));
  write("m-pop", int.format(summary.population));
  write("m-peak", "Peak " + int.format(summary.peakPopulation));
  write("m-biomass", dec.format(summary.mass));
  write("m-mass", summary.population ? dec.format(summary.mass / summary.population) : "—");
  write("m-min", "Minimum " + (minimum >= 0.01 ? dec.format(minimum) : exact(minimum)));
  write("m-generation", summary.population ? int.format(summary.generation) : "—");
  write("m-lifespan", summary.meanLifespan === null ? "—" : dec.format(summary.meanLifespan));
  const samples = summary.lifespanSamples;
  write("m-lifespan-detail", samples
    ? "Ticks · last " + int.format(samples) + (samples === 1 ? " death" : " deaths")
    : "Ticks");
  write("dish-caption", int.format(snapshot.cells.length) + " hexes · Radius " + snapshot.cells.at(-1).r);
  for (const kind of ["energy", "waste"]) {
    const capacity = summary[kind + "Capacity"];
    const used = summary[kind];
    write(kind + "-value", dec.format(used) + " / " + dec.format(capacity));
    $(kind + "-bar").style.width = (capacity ? Math.min(100, used / capacity * 100) : used > 0 ? 100 : 0) + "%";
  }
  write("food-produced", dec.format(summary.foodProduced));
  write("food-eaten", dec.format(summary.foodConsumed));
  write("food-recycled", dec.format(summary.foodRecycled));
  write("deaths-sudden", int.format(summary.totals.suddenDeaths));
  write("deaths-persistence", int.format(summary.totals.persistenceDeaths));
  write("mutations", int.format(summary.totals.mutations));
  for (let i = 0; i < ACTIVITIES.length; i++) {
    const stats = summary.activities[i];
    const enabled = appliedParams[ACTIVITY_ENABLED_KEYS[i]];
    write("activity-probability-" + i, formatProbability(summary.meanDecisionProbabilities[i]));
    write("activity-selected-" + i, enabled ? int.format(stats.selected) : "—");
    write("activity-attempted-" + i, enabled ? int.format(stats.attempted) : "—");
    write("activity-done-" + i, enabled ? int.format(stats.succeeded) : "—");
  }
}

function renderPopulationGenetics(summary) {
  write("population-decision-count", summary.decisionCount
    ? int.format(summary.decisionCount) + (summary.decisionCount === 1 ? " entity decided" : " entities decided")
    : "No decisions this tick");
  for (let i = 0; i < ACTIVITIES.length; i++) {
    for (let j = 0; j < COEFFICIENTS.length; j++) {
      const [mean] = summary.genes[i * COEFFICIENTS.length + j];
      write("population-genes-table-" + i + "-" + j, mean === null ? "—" : exact(mean));
    }
    write("population-genes-table-" + i + "-" + COEFFICIENTS.length,
      formatProbability(summary.meanDecisionProbabilities[i]));
  }
}

function canvasContext(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return null;
  const density = Math.min(2, window.devicePixelRatio || 1);
  const pixelsWide = Math.ceil(width * density);
  const pixelsHigh = Math.ceil(height * density);
  if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
    canvas.width = pixelsWide;
    canvas.height = pixelsHigh;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(density, 0, 0, density, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return {ctx, width, height};
}

function hexPath(ctx, x, y, radius) {
  const side = Math.sqrt(3) * radius / 2;
  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + side, y - radius / 2);
  ctx.lineTo(x + side, y + radius / 2);
  ctx.lineTo(x, y + radius);
  ctx.lineTo(x - side, y + radius / 2);
  ctx.lineTo(x - side, y - radius / 2);
  ctx.closePath();
}

function foodColor(score) {
  const palette = [[37, 45, 31], [99, 105, 57], [190, 132, 62]];
  const edge = score < 0.5 ? 0 : 1;
  const fraction = score * 2 - edge;
  const color = palette[edge].map((start, i) => Math.round(start + fraction * (palette[edge + 1][i] - start)));
  return "rgb(" + color.join(",") + ")";
}

function renderDish() {
  const canvas = $("dish");
  const context = canvasContext(canvas);
  if (!context || !snapshot) return;
  const {ctx, width, height} = context;
  const cells = snapshot.cells;
  const radius = cells.at(-1).r;
  hexSize = Math.min(68, (width - 34) / (Math.sqrt(3) * (2 * radius + 1)), (height - 34) / (3 * radius + 2));
  const centerX = width / 2;
  const centerY = height / 2;
  const highest = cells.reduce((largest, cell) => Math.max(cell.food, largest), 0);
  const normalizer = Math.log1p(highest) || 1;
  write("food-scale", highest >= 1000 ? compact.format(highest) : dec.format(highest));
  ctx.strokeStyle = "#7583602a";
  ctx.lineWidth = 1;
  for (const fraction of [0.37, 0.46]) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.min(width, height) * fraction, 0, 2 * Math.PI);
    ctx.stroke();
  }

  hexPositions = cells.map(({q, r}) => [
    centerX + Math.sqrt(3) * hexSize * (q + r / 2), centerY + 1.5 * hexSize * r,
  ]);
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    const [x, y] = hexPositions[index];
    hexPath(ctx, x, y, hexSize - Math.min(1, hexSize * 0.12));
    ctx.fillStyle = foodColor(Math.log1p(cell.food) / normalizer);
    ctx.fill();
    ctx.lineWidth = hexSize > 9 ? 0.9 : 0.55;
    ctx.strokeStyle = "#797e535e";
    ctx.stroke();
    if (cell.population > 0) drawOccupants(ctx, x, y, cell.population);
  }
  for (const [index, color, weight] of [[hoverCell, "#d6cc9a", 1.15], [watch.cell, "#f3c984", 1.8]]) {
    if (!hexPositions[index]) continue;
    const [x, y] = hexPositions[index];
    hexPath(ctx, x, y, hexSize - Math.min(0.6, hexSize * 0.08));
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    ctx.stroke();
  }
}

function drawOccupants(ctx, x, y, population) {
  const dot = Math.max(1.15, Math.min(3, hexSize * 0.13));
  ctx.fillStyle = "#dbedaa";
  if (population > 4 && hexSize > 13) {
    ctx.fillStyle = "#131c13d9";
    ctx.beginPath();
    ctx.arc(x, y, Math.min(11, hexSize * 0.56), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e1f5b3";
    ctx.font = "600 " + (hexSize > 17 ? 10 : 8) + "px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(population > 999 ? compact.format(population) : String(population), x, y + 0.4);
    return;
  }
  const dots = Math.min(population, hexSize < 9 ? 1 : 4);
  for (let i = 0; i < dots; i++) {
    const angle = (i * Math.PI * 2) / dots - Math.PI / 2;
    const distance = dots === 1 ? 0 : Math.min(6, hexSize * 0.30);
    ctx.beginPath();
    ctx.arc(x + distance * Math.cos(angle), y + distance * Math.sin(angle), dot, 0, Math.PI * 2);
    ctx.fill();
  }
}

function cellAt(x, y) {
  const step = Math.sqrt(3);
  for (let index = 0; index < hexPositions.length; index++) {
    const dx = Math.abs(x - hexPositions[index][0]);
    const dy = Math.abs(y - hexPositions[index][1]);
    if (dx <= hexSize * step / 2 && dy <= hexSize - dx / step) return index;
  }
  return -1;
}

function pointCell(event) {
  const bounds = $("dish").getBoundingClientRect();
  return cellAt(event.clientX - bounds.left, event.clientY - bounds.top);
}

function watchCell(cell, entityId = null) {
  if (!snapshot?.cells[cell]) return;
  watch = {cell, entityId, token: watch.token + 1};
  if (inspector?.cell !== cell) inspector = null;
  renderDish();
  renderInspector();
  post("inspect", {watch});
}

function keyMove(event) {
  const offset = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
  if (!offset || !snapshot?.cells[watch.cell]) return;
  event.preventDefault();
  const current = snapshot.cells[watch.cell];
  const index = snapshot.cells.findIndex(cell => cell.q === current.q + offset[0] && cell.r === current.r + offset[1]);
  if (index >= 0) watchCell(index);
}

function renderInspector() {
  const cell = snapshot?.cells[watch.cell];
  if (!cell) return;
  const details = inspector?.cell === watch.cell ? inspector : null;
  write("hex-address", cell.q + ", " + cell.r);
  write("hex-count", int.format(details?.ids.length ?? cell.population));
  write("hex-food", dec.format(details?.food ?? cell.food));
  const selected = details?.entity;
  $("entity-details").hidden = !selected;
  $("empty-hex").hidden = !!selected;
  $("inspected-tick").hidden = !details || inspectedAt === snapshot.tick;
  if (!$("inspected-tick").hidden) write("inspected-tick", "Inspected at tick " + int.format(inspectedAt));
  if (!selected) {
    write("empty-hex", inspector ? "No entities in this hex." : "Reading hex…");
    return;
  }
  const select = $("entity-select");
  const ids = inspector.ids.join(",");
  if (ids !== occupantOptions) {
    occupantOptions = ids;
    const options = document.createDocumentFragment();
    for (const id of inspector.ids) options.append(new Option("Entity " + int.format(id), id));
    select.replaceChildren(options);
  }
  select.value = selected.id;
  write("entity-mass", dec.format(selected.mass));
  write("entity-energy", dec.format(selected.energy));
  write("entity-waste", dec.format(selected.waste));
  write("entity-origin", "Generation " + int.format(selected.generation) + " · Born at tick " + int.format(selected.born)
    + (selected.parentId ? " · Parent " + int.format(selected.parentId) : " · Founder"));
  const probabilities = selected.lastDecisionProbabilities;
  write("entity-decision-tick", probabilities ? "Tick " + int.format(inspectedAt) : "No decisions this tick");
  for (let i = 0; i < ACTIVITIES.length; i++) {
    write("entity-genes-table-" + i + "-0", formatProbability(probabilities?.[i] ?? null));
    for (let j = 0; j < COEFFICIENTS.length; j++) {
      write("entity-genes-table-" + i + "-" + (j + 1), exact(selected.coefficients[i * COEFFICIENTS.length + j]));
    }
  }
}

function plotRange(series, nonnegative, minimumMaximum = 1) {
  let minimum = nonnegative ? 0 : Infinity;
  let maximum = nonnegative ? minimumMaximum : -Infinity;
  for (const line of series) {
    for (const value of line.values) {
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  if (!Number.isFinite(minimum)) return [-1, 1];
  if (nonnegative) {
    const perMark = maximum / 4;
    const order = 10 ** Math.floor(Math.log10(perMark));
    const step = [1, 2, 2.5, 5, 10].find(candidate => candidate * order >= perMark) * order;
    return [0, chart === "population" ? Math.max(1, step) * 4 : step * 4];
  }
  if (minimum === maximum) {
    const extra = Math.max(0.01, Math.abs(minimum) * 0.05);
    return [minimum - extra, maximum + extra];
  }
  const padding = (maximum - minimum) * 0.07;
  return [minimum - padding, maximum + padding];
}

function axisValue(value) {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return compact.format(value);
  if (magnitude > 0 && magnitude < 0.01) return value.toExponential(1);
  return dec.format(value);
}

function renderHistory() {
  const context = canvasContext($("history"));
  if (!context || history.length === 0) return;
  const metric = $("gene-select").selectedOptions[0];
  const probabilityActivity = metric.dataset.probabilityActivity;
  const probabilityChart = chart === "genetics" && probabilityActivity !== undefined;
  const first = history[0].tick;
  const last = history.at(-1).tick;
  let series;
  let legend;
  if (chart === "population") {
    series = [{name: "Population", color: "#ccdfa4", values: history.map(record => record.population)}];
    legend = series;
    write("history-caption", "Population by tick");
  } else if (chart === "resources") {
    series = [
      {name: "Food", color: "#eeb463", values: history.map(record => record.food)},
      {name: "Energy", color: "#ccdfa4", values: history.map(record => record.energy)},
      {name: "Waste", color: "#bc9ecf", values: history.map(record => record.waste)},
    ];
    legend = series;
    write("history-caption", "Dish-wide stocks by tick");
  } else if (probabilityChart) {
    const activity = Number(probabilityActivity);
    series = [{
      name: ACTIVITIES[activity] + " mean probability",
      color: "#ccdfa4",
      values: history.map(record => record.meanDecisionProbabilities[activity]),
    }];
    legend = series;
    write("history-caption", "Mean decision probability by tick");
  } else {
    const gene = Number(metric.value);
    const coefficient = history.map(record => record.genes[gene]);
    series = [
      {name: "Mean", color: "#ccdfa4", values: coefficient.map(([mean]) => mean)},
      {name: "Upper", color: "#8c9c6b", values: coefficient.map(([mean, sd]) => mean === null ? null : mean + sd)},
      {name: "Lower", color: "#8c9c6b", values: coefficient.map(([mean, sd]) => mean === null ? null : mean - sd)},
    ];
    legend = [series[0], {name: "±1 standard deviation", color: "#8c9c6b"}];
    write("history-caption", "Inherited coefficient by tick");
  }
  if (first > 0) $("history-caption").textContent += " · Latest " + int.format(CHART_WINDOW) + " ticks";
  const lastPoint = series[0].values.at(-1);
  const formatValue = probabilityChart ? formatProbability : axisValue;
  const noValue = probabilityChart ? ". No probability recorded at this tick." : ". No surviving entities.";
  $("history").setAttribute("aria-label", series[0].name + " from tick " + first + " to " + last
    + (lastPoint === null ? noValue : ". Latest value " + formatValue(lastPoint) + "."));
  drawLegend(legend);
  drawChart(context, series, first, last, probabilityChart);
}

function drawLegend(legend) {
  const key = legend.map(line => line.name).join(",");
  if (key === lastLegend) return;
  lastLegend = key;
  $("chart-legend").replaceChildren(...legend.map(line => {
    const node = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.setProperty("--swatch", line.color);
    node.append(swatch, line.name);
    return node;
  }));
}

function drawChart({ctx, width, height}, series, first, last, probabilityChart) {
  const coefficientBand = chart === "genetics" && !probabilityChart;
  const [min, max] = plotRange(series, !coefficientBand, probabilityChart ? 0.01 : 1);
  const formatAxis = probabilityChart ? percent.format : axisValue;
  const left = 47;
  const right = width - 13;
  const top = 9;
  const bottom = height - 23;
  const x = index => left + (right - left) * index / Math.max(1, last - first);
  const y = value => bottom - (value - min) / (max - min) * (bottom - top);
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#aaa895";
  ctx.strokeStyle = "#3a3e30";
  ctx.lineWidth = 1;
  for (let mark = 0; mark <= 4; mark++) {
    const value = min + (max - min) * mark / 4;
    const position = y(value);
    ctx.fillText(formatAxis(value), left - 6, position);
    ctx.beginPath();
    ctx.moveTo(left, position);
    ctx.lineTo(right, position);
    ctx.stroke();
  }
  const labels = last === first ? [first] : [first, Math.round((first + last) / 2), last];
  for (const label of new Set(labels)) {
    ctx.textAlign = label === first ? "left" : label === last ? "right" : "center";
    ctx.fillText(int.format(label), x(label - first), height - 10);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 3, top - 5, right - left + 6, bottom - top + 9);
  ctx.clip();
  if (coefficientBand) {
    const upper = series[1].values;
    const lower = series[2].values;
    const lastValid = upper.findLastIndex(Number.isFinite);
    const firstValid = upper.findIndex(Number.isFinite);
    if (lastValid >= 0) {
      ctx.beginPath();
      ctx.moveTo(x(firstValid), y(upper[firstValid]));
      for (let i = firstValid + 1; i <= lastValid; i++) ctx.lineTo(x(i), y(upper[i]));
      for (let i = lastValid; i >= firstValid; i--) ctx.lineTo(x(i), y(lower[i]));
      ctx.closePath();
      ctx.fillStyle = "#b9ce8239";
      ctx.fill();
    }
  }
  const lines = coefficientBand ? series.slice(0, 1) : series;
  for (const line of lines) {
    ctx.beginPath();
    let located = false;
    let latestIndex = -1;
    line.values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        located = false;
        return;
      }
      if (located) ctx.lineTo(x(index), y(value));
      else ctx.moveTo(x(index), y(value));
      latestIndex = index;
      located = true;
    });
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.7;
    ctx.stroke();
    if (latestIndex >= 0) {
      ctx.beginPath();
      ctx.arc(x(latestIndex), y(line.values[latestIndex]), 2.7, 0, Math.PI * 2);
      ctx.fillStyle = line.color;
      ctx.fill();
    }
  }
  ctx.restore();
}

function mountEvents() {
  $("speed").addEventListener("input", updateTiming);
  $("refresh").addEventListener("input", updateTiming);
  $("model-preset").addEventListener("change", event => {
    const preset = MODEL_PRESETS[event.target.value];
    if (preset) setLiveParameters(preset);
  });
  const pauseInput = $("pause-at-tick");
  pauseInput.value = String(pauseAtTick);
  const commitPauseTick = () => {
    const value = pauseInput.valueAsNumber;
    if (Number.isSafeInteger(value) && value >= 0 && value !== pauseAtTick) {
      pauseAtTick = value;
      post("pause-at-tick", {tick: pauseAtTick});
    }
    pauseInput.value = String(pauseAtTick);
  };
  pauseInput.addEventListener("change", commitPauseTick);
  pauseInput.addEventListener("blur", commitPauseTick);
  pauseInput.addEventListener("keydown", event => { if (event.key === "Enter") commitPauseTick(); });
  $("play").addEventListener("click", () => {
    commandPending = true;
    $("play").disabled = true;
    $("step").disabled = true;
    $("setup-fields").disabled = true;
    post(running ? "pause" : "start");
  });
  $("step").addEventListener("click", () => {
    commandPending = true;
    $("play").disabled = true;
    $("step").disabled = true;
    $("setup-fields").disabled = true;
    post("step");
  });
  $("restart").addEventListener("click", newRun);
  $("export").addEventListener("click", () => {
    $("export").disabled = true;
    post("export");
  });
  $("dish").addEventListener("click", event => watchCell(pointCell(event)));
  $("dish").addEventListener("pointermove", event => {
    if (event.pointerType !== "mouse") return;
    const next = pointCell(event);
    if (hoverCell === next) return;
    hoverCell = next;
    renderDish();
  });
  $("dish").addEventListener("pointerleave", () => {
    if (hoverCell === -1) return;
    hoverCell = -1;
    renderDish();
  });
  $("dish").addEventListener("keydown", keyMove);
  $("entity-select").addEventListener("change", event => watchCell(watch.cell, Number(event.target.value)));
  $("gene-select").addEventListener("change", renderHistory);
  for (const button of all("[data-chart]")) {
    button.addEventListener("click", () => {
      chart = button.dataset.chart;
      for (const tab of all("[data-chart]")) tab.setAttribute("aria-pressed", String(tab === button));
      $("population-genetics").hidden = chart !== "genetics";
      $("gene-select-row").hidden = chart !== "genetics";
      renderHistory();
    });
  }
  new ResizeObserver(() => {
    renderDish();
    renderHistory();
  }).observe($("dish"));
  new ResizeObserver(renderHistory).observe($("history"));
}

function launch() {
  mountControls();
  const source = new Blob([$("worker-source").textContent], {type: "text/javascript"});
  const url = URL.createObjectURL(source);
  worker = new Worker(url);
  worker.addEventListener("message", receive);
  worker.addEventListener("error", () => {
    renderStatus("error", snapshot?.tick || 0);
    $("run-notice").textContent = "The simulation worker could not start.";
    $("restart").disabled = true;
  });
  mountEvents();
  updateTiming();
  newRun();
}

launch();
