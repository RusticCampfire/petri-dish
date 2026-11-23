"use strict";

const {ACTIVITIES, ACTIVITY_ENABLED_KEYS, COEFFICIENTS, GENE_TREE, DEFAULT_SETUP, DEFAULT_PARAMS,
  DEFAULT_PAUSE_TICK, SPEEDS, REFRESHES, CHART_WINDOW, SUCCESS_RATE_AVERAGE_TICKS, sigmoid, dotProduct} = Petri;
const HISTORY_BUFFER_SIZE = CHART_WINDOW + SUCCESS_RATE_AVERAGE_TICKS - 1;
const ACTIVITY_DISPLAY_ORDER = [...new Set([
  "Reproduction", "Movement", "Growth", "Shrinking", "Excretion", ...ACTIVITIES,
])].map(name => ACTIVITIES.indexOf(name)).filter(index => index >= 0);
const DEFAULT_MODEL_PARAMS = Object.fromEntries(
  Object.entries(DEFAULT_PARAMS).filter(([key]) => !ACTIVITY_ENABLED_KEYS.includes(key)),
);
const MODEL_PRESETS = {
  default: DEFAULT_MODEL_PARAMS,
  "scarce-food": {...DEFAULT_MODEL_PARAMS, foodMean: 1.5, foodSD: 8},
};
const STANDARD_DEVIATION_FILL = "#b9ce8239";
const $ = id => document.getElementById(id);
const all = selector => Array.from(document.querySelectorAll(selector));
const write = (id, value) => { $(id).textContent = value; };
const int = new Intl.NumberFormat("en", {maximumFractionDigits: 0});
const dec = new Intl.NumberFormat("en", {maximumFractionDigits: 2});
const percent = new Intl.NumberFormat("en", {style: "percent", maximumFractionDigits: 2});
const compact = new Intl.NumberFormat("en", {notation: "compact", maximumFractionDigits: 1});
const exact = value => value === 0 ? "0" : value.toPrecision(3);
const controls = new Map();
const switchRows = [];
const histogramBins = [];
const sigmoidButtons = new Map();

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
    ["connectionCost", "Connection maintenance", "E/ON/tick", 0, 0.1, 0.001],
    ["failedAttemptFraction", "Failed-attempt fraction", "%", 0, 100, 0.1, {scale: 100, max: 100}],
  ]],
  ["Activity settings", false, [
    ["reproductionCost", "Reproduction cost", "E", 0, 12, 0.1],
    ["divisionLoss", "Division mass loss", "%", 0, 100, 1, {scale: 100, max: 100}],
    ["offspringShare", "Offspring share", "%", 1, 99, 1, {scale: 100, min: 0.01, max: 99.99}],
    ["movementCost", "Movement cost", "E/M", 0, 0.5, 0.005],
    ["growthFraction", "Mass growth", "%", 0, 100, 1, {scale: 100, max: 100}],
    ["growthSpread", "Growth spread", "%", 0, 100, 1, {scale: 100}],
    ["shrinkFraction", "Mass shrinking", "%", 0, 100, 1, {scale: 100, max: 100}],
    ["excretionRate", "Excretion rate", "W/S", 0, 4, 0.05],
    ["excretionCost", "Excretion cost", "E/W", 0, 0.5, 0.005],
  ]],
  ["Inheritance", false, [
    ["mutationRate", "Numerical copying error (μw)", "%", 0, 20, 0.1, {scale: 100, max: 100}],
    ["switchMutationRate", "Switch copying error (μs)", "%", 0, 5, 0.01, {scale: 100, max: 100}],
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
  ["weightRange", "Founder & activation range ±", "", 0, 10, 0.001],
];

let worker;
let runId = 0;
let ready = false;
let running = false;
let commandPending = false;
let fileBusy = false;
let setupLocked = false;
let failed = false;
let checkpoint = false;
let pauseAtTick = DEFAULT_PAUSE_TICK;
let setup = {...DEFAULT_SETUP, startingGeneSwitches: {...DEFAULT_SETUP.startingGeneSwitches}};
let params = {...DEFAULT_PARAMS};
let snapshot = null;
let latestSummary = null;
let selectedBin = null;
let geneRevision = 0;
let historyBuffer = [];
let lastFrame = 0;
let watch = {cell: 45, entityId: null, token: 0};
let hoverCell = -1;
let hexPositions = [];
let hexSize = 0;
let inspector = null;
let inspectedAt = 0;
let chart = "entities";
let sigmoidActivity = ACTIVITY_DISPLAY_ORDER[0];
let occupantOptions = "";
let lastLegend = "";
let lastExcluded = null;

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

function normalizeSetup({keepStores = false} = {}) {
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
  if (!keepStores) {
    setup.initialEnergy = Math.min(setup.initialEnergy, Number(energy.number.max));
    setup.initialWaste = Math.min(setup.initialWaste, Number(waste.number.max));
  }
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
  syncPreset();
}

function syncPreset() {
  const selected = Object.keys(MODEL_PRESETS).find(name =>
    Object.entries(MODEL_PRESETS[name]).every(([key, value]) => params[key] === value)
  );
  $("model-preset").value = selected ?? "";
}

function syncGeneTree() {
  for (const {keys, checkbox, count} of switchRows) {
    const selected = keys.filter(key => setup.startingGeneSwitches[key]).length;
    checkbox.checked = selected === keys.length;
    checkbox.indeterminate = selected > 0 && selected < keys.length;
    if (count) count.textContent = selected + "/" + keys.length;
  }
}

function mountGeneNode(node, list, ancestors = []) {
  const item = document.createElement("li");
  const row = document.createElement("div");
  row.className = "gene-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const path = [...ancestors, node.label];
  const root = !ancestors.length;
  let keys;
  let count;
  item.append(row);
  list.append(item);
  if (node.children) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "gene-disclosure";
    toggle.textContent = node.label;
    const group = document.createElement("div");
    group.id = "gene-branch-" + path.join("-").toLowerCase().replaceAll(" ", "-");
    group.hidden = true;
    toggle.setAttribute("aria-controls", group.id);
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      group.hidden = !group.hidden;
      toggle.setAttribute("aria-expanded", String(!group.hidden));
    });
    count = document.createElement("span");
    count.className = "gene-count";
    count.title = "Selected inputs in this branch";
    checkbox.setAttribute("aria-label", root ? "All gene switches" : "All " + node.label.toLowerCase() + " inputs");
    row.append(toggle, count, checkbox);
    const children = document.createElement("ul");
    group.append(children);
    item.append(group);
    keys = node.children.flatMap(child => mountGeneNode(child, children, path));
    if (root) {
      const help = document.createElement("p");
      help.className = "gene-help";
      help.textContent = "Founders use these switches. During a run, OFF clears the selected weights and ON redraws them for every entity at the next tick. Descendants can still mutate them.";
      const status = document.createElement("p");
      status.id = "gene-reset-status";
      status.className = "gene-help gene-reset-status";
      status.setAttribute("role", "status");
      status.hidden = true;
      group.append(help, status);
    }
  } else {
    keys = [node.key];
    checkbox.id = "gene-" + node.key.replaceAll(".", "-");
    checkbox.setAttribute("aria-label", path.slice(1).join(" · "));
    const label = document.createElement("label");
    label.htmlFor = checkbox.id;
    label.textContent = node.label;
    row.append(label, checkbox);
  }
  switchRows.push({keys, checkbox, count});
  checkbox.addEventListener("change", () => {
    const values = Object.fromEntries(keys.map(key => [key, checkbox.checked]));
    Object.assign(setup.startingGeneSwitches, values);
    syncGeneTree();
    post("gene-switches", {values, revision: ++geneRevision});
  });
  return keys;
}

function mountControls() {
  const geneTree = {...GENE_TREE, children: ACTIVITY_DISPLAY_ORDER.map(index => GENE_TREE.children[index])};
  mountGeneNode(geneTree, $("gene-tree"));
  syncGeneTree();
  mountHistogram();
  for (const [name, open, knobs] of GROUPS) {
    const detail = document.createElement("details");
    detail.className = "parameter-group";
    detail.open = open;
    const summary = document.createElement("summary");
    summary.textContent = name;
    const content = document.createElement("div");
    content.className = "knobs";
    for (const knob of knobs) content.append(makeKnob(knob, params, "live"));
    if (name === "Inheritance") {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "Switching OFF discards the weight. Switching ON draws a fresh weight uniformly from the founder range.";
      content.append(note);
    }
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

  for (const i of ACTIVITY_DISPLAY_ORDER) {
    const el = document.createElement("div");
    el.className = "activity-row";
    el.innerHTML = '<span class="value"></span><span class="value"></span><span class="value"></span>'
      + '<span class="value success"></span><span class="value success"></span>';
    const [probability, selected, attempted, done, rate] = el.children;
    el.prepend(makeKnob([ACTIVITY_ENABLED_KEYS[i], ACTIVITIES[i], "toggle"], params, "live"));
    probability.id = "activity-probability-" + i;
    selected.id = "activity-selected-" + i;
    attempted.id = "activity-attempted-" + i;
    done.id = "activity-done-" + i;
    rate.id = "activity-success-rate-" + i;
    $("activity-list").append(el);
  }
  const historySelect = $("entity-metric");
  for (const activity of ACTIVITY_DISPLAY_ORDER) {
    const name = ACTIVITIES[activity];
    const group = document.createElement("optgroup");
    group.label = name;
    const successRate = new Option(name + " · Success rate", "success-rate-" + activity);
    successRate.dataset.successRateActivity = String(activity);
    const probability = new Option(name + " · Mean probability", "probability-" + activity);
    probability.dataset.probabilityActivity = String(activity);
    group.append(successRate, probability);
    for (let j = 0; j < COEFFICIENTS.length; j++) {
      group.append(new Option(name + " · " + COEFFICIENTS[j], activity * COEFFICIENTS.length + j));
    }
    historySelect.append(group);
  }
  const patterns = document.createElement("optgroup");
  patterns.label = "Switch patterns";
  patterns.append(new Option("Pattern diversity", "patterns"), new Option("Most common pattern share", "dominance"));
  historySelect.append(patterns);
  const reproduction = ACTIVITIES.indexOf("Reproduction");
  const bias = COEFFICIENTS.indexOf("Bias");
  historySelect.value = String(reproduction * COEFFICIENTS.length + bias);
  mountActivityTable("population-genes-table", [...COEFFICIENTS, "Mean probability", "Success rate"], "Population averages", 1, true);
  mountActivityTable("entity-genes-table", ["Last probability", "Bias", "M", "E", "W"], "Decision coefficients", 2);
}

function mountActivityTable(id, columns, name, firstWeightColumn, selectable = false) {
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
  for (const i of ACTIVITY_DISPLAY_ORDER) {
    const row = body.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    if (selectable) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = ACTIVITIES[i];
      button.setAttribute("aria-controls", "activity-sigmoid");
      button.setAttribute("aria-pressed", String(i === sigmoidActivity));
      row.classList.add("sigmoid-row");
      row.classList.toggle("selected", i === sigmoidActivity);
      row.addEventListener("click", () => selectSigmoidActivity(i));
      sigmoidButtons.set(i, button);
      th.append(button);
    } else {
      th.textContent = ACTIVITIES[i];
    }
    row.append(th);
    for (let j = 0; j < columns.length; j++) {
      const cell = row.insertCell();
      cell.id = id + "-" + i + "-" + j;
      if (j >= firstWeightColumn && j < firstWeightColumn + COEFFICIENTS.length - 1) {
        cell.append(document.createElement("span"), document.createElement("small"));
      } else {
        cell.textContent = "—";
      }
    }
  }
  $(id).append(table);
}

function connectionIndex(activity, coefficient) {
  return activity * (COEFFICIENTS.length - 1) + coefficient - 1;
}

function writeWeight(cell, value, detail) {
  cell.firstElementChild.textContent = value;
  cell.lastElementChild.textContent = detail;
}

function formatOnFraction(fraction) {
  if (fraction === 0 || fraction === 1) return percent.format(fraction);
  return formatProbability(fraction);
}

function formatProbability(value) {
  if (value === null) return "—";
  if (value < 0.0001) return "<0.01%";
  if (value > 0.9999) return ">99.99%";
  return percent.format(value);
}

function activitySuccessRate(stats) {
  return stats?.attempted > 0 && Number.isFinite(stats.succeeded) ? stats.succeeded / stats.attempted : null;
}

function activitySuccessRates(activities) {
  return ACTIVITIES.map((_, i) => activitySuccessRate(activities?.[i]));
}

function chooseCenter() {
  watch = {cell: (hexCount(setup.radius) - 1) / 2, entityId: null, token: watch.token + 1};
  inspector = null;
  hoverCell = -1;
}

function resetRunView() {
  lastFrame = 0;
  commandPending = false;
  snapshot = null;
  latestSummary = null;
  selectedBin = null;
  geneRevision = 0;
  $("gene-reset-status").hidden = true;
  historyBuffer = [];
}

function newRun() {
  runId++;
  resetRunView();
  setFileStatus("");
  normalizeSetup();
  chooseCenter();
  renderStatus("loading", 0);
  post("reset", {setup, params, watch, speed: speedValue(), refresh: refreshValue(), pauseAtTick});
}

function syncFileButtons() {
  $("import").disabled = !ready || fileBusy;
  $("export").disabled = !ready || fileBusy || failed;
  $("restart").disabled = !ready || fileBusy;
}

function setFileStatus(message, error = false) {
  write("file-status", message);
  $("file-status").classList.toggle("error", error);
}

function renderStatus(reason, tick) {
  ready = reason !== "loading";
  checkpoint = reason === "checkpoint";
  failed = reason === "error";
  running = reason === "running";
  setFaviconRunning(running);
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
  syncFileButtons();
  $("play").lastElementChild.textContent = running ? "Pause" : tick > 0 ? "Resume" : "Start";
  $("play").firstElementChild.className = "icon " + (running ? "icon-pause" : "icon-play");
  $("setup-fields").disabled = setupLocked;
  write("setup-state", setupLocked ? "Locked until restart" : "New run");
  const notice = $("run-notice");
  notice.hidden = !checkpoint && !failed;
  notice.classList.toggle("error", failed);
  if (checkpoint) notice.textContent = "Paused at tick " + int.format(tick) + ". Resume to continue.";
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
  latestSummary = data.summary;
  if (data.watchToken === watch.token) {
    inspector = snapshot.inspect;
    inspectedAt = snapshot.tick;
  }
  renderGauges(data.summary, data.minimumMass);
  renderPopulationGenetics(data.summary);
  renderDish();
  renderInspector();
  renderHistory();
}

function formatExcludedActivities(excludedActivities) {
  return ACTIVITY_DISPLAY_ORDER.map(index => ACTIVITIES[index])
    .filter(name => excludedActivities.includes(name)).join(", ");
}

function appendExclusion({tick, excludedActivities}) {
  const excluded = formatExcludedActivities(excludedActivities);
  if (lastExcluded === excluded) return;
  const item = document.createElement("li");
  item.textContent = "Tick " + int.format(tick) + " · " + (excluded ? excluded + " excluded" : "All activities enabled");
  $("exclusion-history").prepend(item);
  lastExcluded = excluded;
}

function showImportedRun(data) {
  runId = data.nextRunId;
  resetRunView();
  setup = data.setup;
  params = data.params;
  watch = data.watch;
  inspector = null;
  hoverCell = -1;
  for (const [key] of SETUP_KNOBS) controls.get(key).sync(setup[key]);
  for (const [key, value] of Object.entries(params)) controls.get(key).sync(value);
  normalizeSetup({keepStores: data.tick > 0});
  syncGeneTree();
  syncPreset();
  $("speed").value = String(SPEEDS.indexOf(data.playback.speed));
  $("refresh").value = String(REFRESHES.indexOf(data.playback.refresh));
  pauseAtTick = data.playback.pauseAtTick;
  $("pause-at-tick").value = String(pauseAtTick);
  updateTiming();
  fileBusy = false;
  renderStatus("loading", data.tick);
  setFileStatus("Loaded tick " + int.format(data.tick) + ". " + (data.tick ? "Resume to continue." : "Press Start to begin.")
    + (data.legacy ? " The lifespan average will rebuild as entities die." : ""));
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
        historyBuffer = [];
        lastExcluded = null;
        $("exclusion-history").replaceChildren();
      }
      if (data.priorActivityStats) {
        // A new chart window starts with off-screen activity counts for its first averages.
        historyBuffer = data.priorActivityStats.map(activities => ({activitySuccessRates: activitySuccessRates(activities)}));
      }
      for (const record of data.earlierExclusions) appendExclusion(record);
      for (const record of data.records) {
        historyBuffer.push({
          tick: record.tick, population: record.population, food: record.food, energy: record.energy,
          waste: record.waste, genes: record.genes.map(([mean, sd]) => [mean, sd]),
          meanDecisionProbabilities: record.meanDecisionProbabilities,
          activitySuccessRates: activitySuccessRates(record.activities),
          connectionOnFractions: record.connectionOnFractions,
          distinctPatterns: record.distinctPatterns, effectivePatterns: record.effectivePatterns,
          dominantPatternShare: record.dominantPatternShare, geneSwitchReset: record.geneSwitchReset,
        });
        appendExclusion(record);
      }
      if (historyBuffer.length > HISTORY_BUFFER_SIZE) historyBuffer.splice(0, historyBuffer.length - HISTORY_BUFFER_SIZE);
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
    case "genes-applied":
      if (data.change) {
        const {tick, weightsDrawn, weightsRemoved} = data.change;
        write("gene-reset-status", "Tick " + int.format(tick) + " · " + int.format(weightsDrawn)
          + " weights drawn · " + int.format(weightsRemoved) + " removed");
        $("gene-reset-status").hidden = false;
      }
      break;
    case "inspector":
      if (data.watchToken !== watch.token) break;
      inspector = data.inspector;
      inspectedAt = data.tick;
      renderInspector();
      break;
    case "export":
      fileBusy = false;
      syncFileButtons();
      try {
        download(data.blob, "petri-dish-tick-" + data.tick + ".json" + (data.gzip ? ".gz" : ""));
        setFileStatus("Download started for tick " + int.format(data.tick) + ".");
      } catch (error) {
        setFileStatus("Could not download the run. " + error.message, true);
      }
      break;
    case "imported":
      showImportedRun(data);
      break;
    case "file-error":
      fileBusy = false;
      syncFileButtons();
      setFileStatus((data.operation === "export" ? "Export failed. " : "Import failed. ") + data.message, true);
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
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
  write("switch-flips", int.format(summary.totals.switchFlips));
  write("excluded-status", summary.excludedActivities.length
    ? "Excluded · " + formatExcludedActivities(summary.excludedActivities) : "All activities enabled");
  for (const i of ACTIVITY_DISPLAY_ORDER) {
    const stats = summary.activities[i];
    const enabled = !summary.excludedActivities.includes(ACTIVITIES[i]);
    write("activity-probability-" + i, formatProbability(summary.meanDecisionProbabilities[i]));
    write("activity-selected-" + i, enabled ? int.format(stats.selected) : "—");
    write("activity-attempted-" + i, enabled ? int.format(stats.attempted) : "—");
    write("activity-done-" + i, enabled ? int.format(stats.succeeded) : "—");
    write("activity-success-rate-" + i, formatOnFraction(activitySuccessRate(stats)));
  }
}

function renderPopulationGenetics(summary) {
  write("population-decision-count", summary.decisionCount
    ? int.format(summary.decisionCount) + (summary.decisionCount === 1 ? " entity decided" : " entities decided")
    : "No decisions this tick");
  write("mean-stored-connections", summary.population ? dec.format(summary.activeConnections / summary.population) : "—");
  write("mean-effective-connections", summary.population ? dec.format(summary.effectiveActiveConnections / summary.population) : "—");
  write("connection-upkeep", axisValue(summary.connectionMaintenancePaid) + " E");
  write("maintained-connections", int.format(summary.maintainedConnections)
    + (summary.maintainedConnections === 1 ? " connection" : " connections"));
  for (const i of ACTIVITY_DISPLAY_ORDER) {
    const bias = summary.genes[i * COEFFICIENTS.length][0];
    write("population-genes-table-" + i + "-0", bias === null ? "—" : exact(bias));
    for (let j = 1; j < COEFFICIENTS.length; j++) {
      const [mean] = summary.genes[i * COEFFICIENTS.length + j];
      const fraction = summary.connectionOnFractions[connectionIndex(i, j)];
      writeWeight($("population-genes-table-" + i + "-" + j), mean === null ? "—" : exact(mean),
        fraction === null ? "" : formatOnFraction(fraction) + " ON");
    }
    write("population-genes-table-" + i + "-" + COEFFICIENTS.length,
      formatProbability(summary.meanDecisionProbabilities[i]));
    write("population-genes-table-" + i + "-" + (COEFFICIENTS.length + 1),
      formatOnFraction(activitySuccessRate(summary.activities[i])));
  }
  write("distinct-patterns", int.format(summary.distinctPatterns));
  write("effective-patterns", summary.effectivePatterns === null ? "—" : dec.format(summary.effectivePatterns));
  write("dominant-share", formatOnFraction(summary.dominantPatternShare));
  write("leading-pattern", describeLeadingPattern(summary));
  renderHistogram(summary);
  renderSigmoid();
}

function selectSigmoidActivity(activity) {
  sigmoidActivity = activity;
  for (const [index, button] of sigmoidButtons) {
    const selected = index === activity;
    button.setAttribute("aria-pressed", String(selected));
    button.closest("tr").classList.toggle("selected", selected);
  }
  renderSigmoid();
}

function sigmoidProjection(summary, activity, input) {
  if (!summary.population) return null;
  const offset = activity * COEFFICIENTS.length;
  const genes = summary.genes.slice(offset, offset + COEFFICIENTS.length).map(([mean]) => mean);
  if (!Number.isFinite(genes[0])) return null;
  const inputs = summary.meanDecisionInputs;
  const average = inputs ? {...inputs, genes} : null;
  const probability = average ? sigmoid(dotProduct(average, 0)) : null;
  if (input === "weighted") {
    const reference = average ? dotProduct({...average, genes: [0, ...genes.slice(1)]}, 0) : null;
    const midpoint = -genes[0];
    const padding = Math.max(6, Math.abs(midpoint) * 16 * Number.EPSILON);
    const mean = Number.isFinite(reference) ? reference : 0;
    const min = Math.max(-Number.MAX_VALUE, Math.min(-6, midpoint - padding, mean));
    const max = Math.min(Number.MAX_VALUE, Math.max(6, midpoint + padding, mean));
    return {min, max, reference, probability, evaluate: value => sigmoid(genes[0] + value)};
  }
  if (!average) return null;
  const deviation = summary.decisionEnergySD;
  const spread = input === "energy" && Number.isFinite(deviation) && deviation >= 0 ? {
    low: Math.max(0, average.energy - deviation),
    high: Math.min(Number.MAX_VALUE, average.energy + deviation),
  } : null;
  const limit = input === "mass" ? average.mass * 2
    : average.mass * (summary[input + "Capacity"] / summary.mass);
  const max = Math.max(average[input], Math.min(Number.MAX_VALUE, limit), spread?.high ?? 0) || 1;
  return {
    min: 0, max, reference: average[input], probability, spread,
    evaluate: value => sigmoid(dotProduct({...average, [input]: value}, 0)),
  };
}

function renderSigmoid() {
  if (chart !== "entities" || !latestSummary) return;
  const canvas = $("sigmoid-curve");
  const context = canvasContext(canvas);
  if (!context) return;
  const select = $("sigmoid-input");
  const input = select.value;
  const axis = input === "weighted" ? "Weighted input before bias" : select.selectedOptions[0].textContent;
  const title = ACTIVITIES[sigmoidActivity] + " sigmoid";
  const plot = sigmoidProjection(latestSummary, sigmoidActivity, input);
  const emptyMessage = latestSummary.population
    ? "No decision inputs recorded for this tick." : "No living entities to average.";
  write("sigmoid-title", title);
  $("sigmoid-empty").hidden = !!plot;
  $("sigmoid-caption").hidden = !plot;
  $("sigmoid-detail").hidden = !plot;
  if (!plot) {
    write("sigmoid-empty", emptyMessage);
    canvas.setAttribute("aria-label", title + ". " + emptyMessage);
    return;
  }
  const hasMarker = Number.isFinite(plot.reference) && Number.isFinite(plot.probability);
  const estimate = hasMarker ? formatProbability(plot.probability) : "";
  const pointLabel = input === "weighted" ? "At mean decision inputs"
    : "At mean " + axis.toLowerCase() + " " + axisValue(plot.reference);
  const {spread} = plot;
  let spreadLabel = "";
  $("sigmoid-spread").hidden = !spread;
  if (spread) {
    const low = axisValue(spread.low);
    const high = axisValue(spread.high);
    write("sigmoid-spread-range", low === high ? low : low + "–" + high);
    spreadLabel = " Energy band " + low + " to " + high + " (±1 standard deviation after persistence).";
  }
  write("sigmoid-axis-label", axis);
  $("sigmoid-estimate").hidden = !hasMarker;
  if (hasMarker) write("sigmoid-point-label", pointLabel);
  write("sigmoid-probability", estimate);
  const detail = !latestSummary.meanDecisionInputs ? emptyMessage
    : input === "weighted" ? "The dot uses mean inputs after persistence."
    : "Other inputs are held at their means after persistence.";
  const excluded = latestSummary.excludedActivities.includes(ACTIVITIES[sigmoidActivity]);
  write("sigmoid-detail", detail + (excluded ? " This activity is excluded." : ""));
  canvas.setAttribute("aria-label", title + ". Decision probability by " + axis.toLowerCase()
    + (hasMarker ? ". " + pointLabel + " after persistence, " + estimate + "." : ". " + detail) + spreadLabel);
  drawSigmoid(context, plot);
}

function drawSigmoid({ctx, width, height}, {min, max, reference, probability, evaluate, spread}) {
  const left = 46;
  const right = width - 9;
  const top = 22;
  const bottom = height - 22;
  const y = value => bottom - value * (bottom - top);
  const at = fraction => min * (1 - fraction) + max * fraction;
  const scale = Math.max(1, Math.abs(min), Math.abs(max));
  const x = value => left + (right - left) * (value / scale - min / scale) / (max / scale - min / scale);
  if (spread && spread.low < spread.high) {
    const lower = x(spread.low);
    ctx.fillStyle = STANDARD_DEVIATION_FILL;
    ctx.fillRect(lower, top, x(spread.high) - lower, bottom - top);
  }
  ctx.font = "10px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#aaa895";
  ctx.textAlign = "left";
  ctx.fillText("Decision probability", left, 6);
  ctx.textAlign = "right";
  ctx.strokeStyle = "#3a3e30";
  ctx.lineWidth = 1;
  for (const probability of [0, 0.25, 0.5, 0.75, 1]) {
    const position = y(probability);
    ctx.fillText(percent.format(probability), left - 6, position);
    ctx.beginPath();
    ctx.moveTo(left, position);
    ctx.lineTo(right, position);
    ctx.stroke();
  }
  for (const fraction of [0, 0.5, 1]) {
    const label = at(fraction);
    ctx.textAlign = fraction === 0 ? "left" : fraction === 1 ? "right" : "center";
    ctx.fillText(Math.abs(label) >= 1e6 ? label.toExponential(1) : axisValue(label),
      left + fraction * (right - left), height - 8);
  }
  ctx.beginPath();
  let located = false;
  for (let i = 0; i <= 160; i++) {
    const fraction = i / 160;
    const value = evaluate(at(fraction));
    if (!Number.isFinite(value)) {
      located = false;
      continue;
    }
    const position = left + fraction * (right - left);
    if (located) ctx.lineTo(position, y(value));
    else ctx.moveTo(position, y(value));
    located = true;
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ccdfa4";
  ctx.stroke();

  if (!Number.isFinite(reference) || !Number.isFinite(probability)) return;
  const pointX = x(reference);
  const pointY = y(probability);
  ctx.beginPath();
  ctx.strokeStyle = "#d6a76c";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.moveTo(pointX, pointY);
  ctx.lineTo(pointX, bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(pointX, pointY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#edb766";
  ctx.fill();
}

function describeLeadingPattern({leadingPattern, leadingPatternCount}) {
  if (!leadingPatternCount) return "No living entities.";
  if (leadingPatternCount > 1) return int.format(leadingPatternCount) + " patterns share the lead.";
  if (!leadingPattern.includes("0")) return "Most common pattern · All inputs ON";
  if (!leadingPattern.includes("1")) return "Most common pattern · All inputs OFF";
  const inputs = COEFFICIENTS.slice(1);
  const groups = [];
  for (const i of ACTIVITY_DISPLAY_ORDER) {
    const on = inputs.filter((_, j) => leadingPattern[connectionIndex(i, j + 1)] === "1");
    if (on.length) groups.push(ACTIVITIES[i] + " (" + on.join(", ") + ")");
  }
  return "Most common pattern · " + groups.join(" · ");
}

function mountHistogram() {
  const length = Object.keys(DEFAULT_SETUP.startingGeneSwitches).length;
  for (let i = 0; i <= length; i++) {
    const bin = document.createElement("button");
    bin.type = "button";
    const bar = document.createElement("i");
    bar.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = i;
    bin.append(bar, label);
    bin.addEventListener("click", () => {
      selectedBin = i;
      if (latestSummary) renderHistogram(latestSummary);
    });
    histogramBins.push(bin);
    $("gene-histogram").append(bin);
  }
}

function renderHistogram({connectionHistogram: bins, population}) {
  const peak = Math.max(...bins);
  const selected = selectedBin ?? bins.indexOf(peak);
  for (let i = 0; i < bins.length; i++) {
    const button = histogramBins[i];
    const count = bins[i];
    const label = i + " ON · " + int.format(count) + (count === 1 ? " entity" : " entities")
      + (population ? " (" + formatOnFraction(count / population) + ")" : "");
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(i === selected && population > 0));
    button.style.setProperty("--height", (peak ? 100 * count / peak : 0) + "%");
    if (i === selected) write("histogram-value", population ? label : "No living entities");
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
  write("entity-connections", "Connections · " + selected.activeConnections + " ON · " + selected.effectiveActiveConnections + " effective");
  const probabilities = selected.lastDecisionProbabilities;
  write("entity-decision-tick", selected.lastDecisionTick === null ? "No decisions this tick" : "Tick " + int.format(selected.lastDecisionTick));
  for (const i of ACTIVITY_DISPLAY_ORDER) {
    write("entity-genes-table-" + i + "-0", formatProbability(probabilities?.[i] ?? null));
    write("entity-genes-table-" + i + "-1", exact(selected.coefficients[i * COEFFICIENTS.length]));
    for (let j = 1; j < COEFFICIENTS.length; j++) {
      const weight = selected.coefficients[i * COEFFICIENTS.length + j];
      writeWeight($("entity-genes-table-" + i + "-" + (j + 1)), weight === null ? "OFF" : exact(weight),
        weight === null ? "" : "ON");
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

function movingSuccessRates(values) {
  let sum = 0;
  let count = 0;
  return values.map((value, i) => {
    const previous = values[i - SUCCESS_RATE_AVERAGE_TICKS];
    if (Number.isFinite(previous)) {
      sum -= previous;
      count--;
    }
    if (count === 0) sum = 0;
    if (Number.isFinite(value)) {
      sum += value;
      count++;
    }
    return count ? Math.max(0, Math.min(1, sum / count)) : null;
  });
}

function renderHistory() {
  const context = canvasContext($("history"));
  if (!context || historyBuffer.length === 0) return;
  const history = historyBuffer.length > CHART_WINDOW ? historyBuffer.slice(-CHART_WINDOW) : historyBuffer;
  const metric = $("entity-metric").selectedOptions[0];
  const {probabilityActivity, successRateActivity} = metric.dataset;
  const entityChart = chart === "entities";
  const probabilityChart = entityChart && probabilityActivity !== undefined;
  const successRateChart = entityChart && successRateActivity !== undefined;
  const gene = Number(metric.value);
  const coefficientChart = entityChart && Number.isInteger(gene);
  const dominanceChart = entityChart && metric.value === "dominance";
  const coefficientIndex = gene % COEFFICIENTS.length;
  const inputChart = coefficientChart && coefficientIndex !== 0;
  $("connection-trend").hidden = !inputChart;
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
  } else if (successRateChart || probabilityChart) {
    const activity = Number(successRateActivity ?? probabilityActivity);
    const field = successRateChart ? "activitySuccessRates" : "meanDecisionProbabilities";
    series = [{
      name: ACTIVITIES[activity] + (successRateChart ? " success rate" : " mean probability"),
      color: successRateChart ? "#ccdfa47a" : "#ccdfa4",
      width: successRateChart ? 1 : undefined,
      values: history.map(record => record[field][activity]),
    }];
    if (successRateChart) {
      const recentRates = historyBuffer.map(record => record.activitySuccessRates[activity]);
      series.push({
        name: SUCCESS_RATE_AVERAGE_TICKS + "-tick moving average",
        color: "#f6ca86",
        width: 2.3,
        values: movingSuccessRates(recentRates).slice(-history.length),
      });
    }
    legend = series;
    write("history-caption", successRateChart ? "Done ÷ Tried by tick" : "Mean decision probability by tick");
  } else if (metric.value === "patterns") {
    series = [
      {name: "Distinct patterns", color: "#ccdfa4", values: history.map(record => record.distinctPatterns)},
      {name: "Effective patterns", color: "#bc9ecf", values: history.map(record => record.effectivePatterns)},
    ];
    legend = series;
    write("history-caption", "Diversity of inherited switch patterns by tick");
  } else if (dominanceChart) {
    series = [{name: "Largest share", color: "#eeb463", values: history.map(record => record.dominantPatternShare)}];
    legend = series;
    write("history-caption", "Share of the population with the most common pattern");
  } else {
    const coefficient = history.map(record => record.genes[gene]);
    series = [
      {name: "Mean", color: "#ccdfa4", values: coefficient.map(([mean]) => mean)},
      {name: "Upper", color: "#8c9c6b", values: coefficient.map(([mean, sd]) => mean === null ? null : mean + sd)},
      {name: "Lower", color: "#8c9c6b", values: coefficient.map(([mean, sd]) => mean === null ? null : mean - sd)},
    ];
    legend = [series[0], {name: "±1 standard deviation", color: "#8c9c6b"}];
    write("history-caption", inputChart ? "Weight among entities with this connection ON" : "Inherited bias by tick");
  }
  if (first > 0) $("history-caption").textContent += " · Latest " + int.format(CHART_WINDOW) + " ticks";
  const lastPoint = series[0].values.at(-1);
  const formatValue = successRateChart || dominanceChart ? formatOnFraction : probabilityChart ? formatProbability : axisValue;
  const noValue = successRateChart ? ". No attempts at this tick."
    : probabilityChart ? ". No probability recorded at this tick."
    : inputChart ? ". No living entity has this connection ON." : ". No surviving entities.";
  const average = successRateChart ? series[1].values.at(-1) : null;
  $("history").setAttribute("aria-label", series[0].name + " from tick " + first + " to " + last
    + (lastPoint === null ? noValue : ". Latest value " + formatValue(lastPoint) + ".")
    + (average === null ? "" : " " + series[1].name + " " + formatOnFraction(average) + "."));
  const resets = entityChart ? history.filter(record => record.geneSwitchReset).map(record => record.tick) : [];
  drawLegend(resets.length ? [...legend, {name: "Manual gene reset", color: "#d6a76c"}] : legend);
  const kind = coefficientChart ? "coefficient" : probabilityChart ? "probability"
    : successRateChart ? "success-rate" : dominanceChart ? "fraction" : chart;
  drawChart(context, series, first, last, kind, resets);
  if (inputChart) {
    const index = connectionIndex(Math.floor(gene / COEFFICIENTS.length), coefficientIndex);
    const values = history.map(record => record.connectionOnFractions[index]);
    const latest = formatOnFraction(values.at(-1));
    write("connection-fraction", latest);
    if (latestSummary) {
      const signs = latestSummary.weightSigns;
      const carriers = signs.negative[index] + signs.zero[index] + signs.positive[index];
      write("weight-signs", carriers ? "Among carriers · " + formatOnFraction(signs.negative[index] / carriers)
        + " negative · " + formatOnFraction(signs.zero[index] / carriers) + " zero · "
        + formatOnFraction(signs.positive[index] / carriers) + " positive" : "No living entity carries this weight.");
    }
    const canvas = $("connection-history");
    canvas.setAttribute("aria-label", metric.text + " connection ON from tick " + first + " to " + last + ". Latest fraction " + latest);
    const fractionContext = canvasContext(canvas);
    if (fractionContext) drawChart(fractionContext, [{color: "#bc9ecf", values}], first, last, "fraction", resets);
  }
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

function drawChart({ctx, width, height}, series, first, last, kind, resets) {
  const coefficientBand = kind === "coefficient";
  const fraction = kind === "fraction";
  const successRate = kind === "success-rate";
  let [min, max] = fraction ? [0, 1]
    : plotRange(series, !coefficientBand && !successRate, kind === "probability" ? 0.01 : 1);
  if (successRate) {
    // Keep the percentage scale valid and give its labels room to remain distinct.
    min = Math.max(0, Math.min(min, 0.999));
    max = Math.min(1, Math.max(max, min + 0.001));
  }
  const formatAxis = fraction || successRate || kind === "probability" ? percent.format : axisValue;
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
  const marks = fraction ? 2 : 4;
  for (let mark = 0; mark <= marks; mark++) {
    const value = min + (max - min) * mark / marks;
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
  if (resets.length) {
    ctx.beginPath();
    ctx.strokeStyle = "#d6a76c";
    ctx.setLineDash([2, 4]);
    for (const tick of resets) {
      const position = x(tick - first);
      ctx.moveTo(position, top);
      ctx.lineTo(position, bottom);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (coefficientBand) {
    const upper = series[1].values;
    const lower = series[2].values;
    ctx.beginPath();
    let start = 0;
    while (start < upper.length) {
      if (!Number.isFinite(upper[start]) || !Number.isFinite(lower[start])) {
        start++;
        continue;
      }
      let end = start + 1;
      ctx.moveTo(x(start), y(upper[start]));
      while (end < upper.length && Number.isFinite(upper[end]) && Number.isFinite(lower[end])) {
        ctx.lineTo(x(end), y(upper[end]));
        end++;
      }
      for (let i = end - 1; i >= start; i--) ctx.lineTo(x(i), y(lower[i]));
      ctx.closePath();
      start = end;
    }
    ctx.fillStyle = STANDARD_DEVIATION_FILL;
    ctx.fill();
  }
  const lines = coefficientBand ? series.slice(0, 1) : series;
  for (const line of lines) {
    ctx.beginPath();
    const points = [];
    let located = false;
    let latestIndex = -1;
    line.values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        located = false;
        return;
      }
      if (located) {
        ctx.lineTo(x(index), y(value));
      } else {
        ctx.moveTo(x(index), y(value));
        if (successRate && !Number.isFinite(line.values[index + 1])) points.push(index);
      }
      latestIndex = index;
      located = true;
    });
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width ?? 1.7;
    ctx.stroke();
    if (latestIndex >= 0) {
      if (points.at(-1) !== latestIndex) points.push(latestIndex);
      ctx.beginPath();
      for (const index of points) {
        const radius = index === latestIndex ? 2.7 : 1.6;
        const positionX = x(index);
        const positionY = y(line.values[index]);
        ctx.moveTo(positionX + radius, positionY);
        ctx.arc(positionX, positionY, radius, 0, Math.PI * 2);
      }
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
    fileBusy = true;
    syncFileButtons();
    setFileStatus("Preparing export…");
    post("export");
  });
  const fileInput = $("import-file");
  $("import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file || fileBusy) return;
    fileBusy = true;
    syncFileButtons();
    setFileStatus("Reading saved run…");
    post("import", {file, nextRunId: runId + 1});
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
  $("entity-metric").addEventListener("change", renderHistory);
  $("sigmoid-input").addEventListener("change", renderSigmoid);
  for (const button of all("[data-chart]")) {
    button.addEventListener("click", () => {
      chart = button.dataset.chart;
      for (const tab of all("[data-chart]")) tab.setAttribute("aria-pressed", String(tab === button));
      $("population-genetics").hidden = chart !== "entities";
      $("entity-metric-row").hidden = chart !== "entities";
      renderHistory();
      renderSigmoid();
    });
  }
  new ResizeObserver(() => {
    renderDish();
    renderHistory();
  }).observe($("dish"));
  new ResizeObserver(renderHistory).observe($("history"));
  new ResizeObserver(renderSigmoid).observe($("sigmoid-curve"));
}

function mountFavicon() {
  const mark = document.querySelector(".brand-mark");
  const style = getComputedStyle(mark);
  const ring = getComputedStyle(mark, "::before");
  const size = parseFloat(style.width);
  const center = size / 2;
  const borderWidth = parseFloat(style.borderTopWidth);
  const ringWidth = parseFloat(ring.borderTopWidth);
  const ringRadius = center - borderWidth - parseFloat(ring.top) - ringWidth / 2;
  const cells = Array.from(mark.children, element => {
    const cell = getComputedStyle(element);
    const radius = parseFloat(cell.width) / 2;
    return {
      x: parseFloat(cell.left) + borderWidth + radius - center,
      y: parseFloat(cell.top) + borderWidth + radius - center,
      radius, color: cell.backgroundColor, opacity: Number(cell.opacity),
    };
  });
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  ctx.scale(canvas.width / size, canvas.height / size);

  const inset = borderWidth / 2;
  const edge = size - inset;
  const radius = parseFloat(style.borderTopLeftRadius) - inset;
  const outline = new Path2D();
  outline.moveTo(inset + radius, inset);
  outline.arcTo(edge, inset, edge, edge, radius);
  outline.arcTo(edge, edge, inset, edge, radius);
  outline.arcTo(inset, edge, inset, inset, radius);
  outline.arcTo(inset, inset, edge, inset, radius);
  outline.closePath();

  const frameCount = 16;
  const frames = Array.from({length: frameCount}, (_, frame) => {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = style.backgroundColor;
    ctx.fill(outline);
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = borderWidth;
    ctx.stroke(outline);
    ctx.beginPath();
    ctx.arc(center, center, ringRadius, 0, 2 * Math.PI);
    ctx.lineWidth = ringWidth;
    ctx.strokeStyle = ring.borderTopColor;
    ctx.stroke();

    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(2 * Math.PI * frame / frameCount);
    for (const cell of cells) {
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cell.radius, 0, 2 * Math.PI);
      ctx.fillStyle = cell.color;
      ctx.globalAlpha = cell.opacity;
      ctx.fill();
    }
    ctx.restore();
    return canvas.toDataURL("image/png");
  });
  const favicon = $("favicon");
  let frame = 0;
  let timer = null;
  favicon.href = frames[frame];
  return isRunning => {
    if (!isRunning) {
      clearInterval(timer);
      timer = null;
    } else if (timer === null) {
      timer = setInterval(() => {
        frame = (frame + 1) % frames.length;
        favicon.href = frames[frame];
      }, 150);
    }
  };
}

function launch() {
  mountControls();
  const embedded = $("worker-source");
  if (embedded) {
    const source = new Blob([$("model-source").textContent, "\n", embedded.textContent], {type: "text/javascript"});
    const url = URL.createObjectURL(source);
    worker = new Worker(url);
    worker.addEventListener("message", () => URL.revokeObjectURL(url), {once: true});
  } else {
    worker = new Worker("./worker.js");
  }
  worker.addEventListener("message", receive);
  worker.addEventListener("error", () => {
    fileBusy = false;
    renderStatus("error", snapshot?.tick || 0);
    $("run-notice").textContent = "The simulation worker could not start.";
    $("restart").disabled = true;
    $("import").disabled = true;
  });
  mountEvents();
  updateTiming();
  newRun();
}

const setFaviconRunning = mountFavicon();
if (location.protocol === "file:" && !$("worker-source")) {
  location.replace("./petri-dish.html");
} else {
  launch();
}
