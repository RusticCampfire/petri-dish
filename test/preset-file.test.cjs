"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {DEFAULT_SETUP, DEFAULT_PARAMS} = require("../src/model.js");
const {createPreset, loadPreset, presetExtension, presetFilename} = require("../src/preset-file.js");

const settings = {
  setup: {
    ...DEFAULT_SETUP, radius: 4, founders: 6,
    startingGeneSwitches: {...DEFAULT_SETUP.startingGeneSwitches, "movement.energy": true},
  },
  params: {...DEFAULT_PARAMS, foodMean: 1.25, reproductionEnabled: false, mutateParent: true},
  scCycle: {period: 100, searchLength: 12, transitionLength: 4, consolidation: {mutationRate: 0.03}},
  playback: {speed: 50, refresh: 1000, pauseAtTick: 1234},
};

test("settings preset files round-trip with model, founder, inheritance and playback settings", () => {
  const preset = createPreset(" Trial / 1 ", settings);
  assert.equal(preset.name, "Trial / 1");
  assert.equal(presetFilename(preset.name), "Trial - 1.evoset");
  assert.equal(preset.settings.params.mutationRate, 0.03);
  assert.equal(preset.settings.params.reproductionEnabled, false);
  assert.equal(preset.settings.setup.startingGeneSwitches["movement.energy"], true);
  assert.deepEqual(loadPreset(JSON.parse(JSON.stringify(preset))), preset);
});

test("new presets use .evoset and the importer recognizes both extensions", () => {
  assert.equal(presetFilename("Trial.PETRIPRESET"), "Trial.evoset");
  assert.equal(presetFilename("Trial.EVOSET"), "Trial.evoset");
  assert.equal(presetFilename(".petripreset"), "settings.evoset");
  assert.equal(presetExtension("Trial.PETRIPRESET"), ".petripreset");
  assert.equal(presetExtension("Trial.EVOSET"), ".evoset");
  assert.equal(presetExtension("Trial.evoset.json"), undefined);
});

test("invalid files and out-of-range preset settings fail validation before they can be applied", () => {
  assert.throws(() => loadPreset({model: "Petri Dish", version: 1}), /supported Petri Dish preset/);
  assert.throws(() => loadPreset({...createPreset("Trial", settings), version: 2}), /supported Petri Dish preset/);
  assert.throws(() => createPreset(" ", settings), /preset name/);
  assert.throws(() => createPreset("Trial", {...settings, setup: {...settings.setup, radius: 50}}), /initial setup/);
  assert.throws(() => createPreset("Trial", {...settings, params: {offspringShare: 2}}), /out of range/);
  assert.throws(() => createPreset("Trial", {...settings, scCycle: {...settings.scCycle, searchLength: 99}}), /fit within the period/);
  assert.throws(() => createPreset("Trial", {...settings, playback: {...settings.playback, speed: 2}}), /playback settings/);
});
