"use strict";

const PetriPreset = (() => {
  const {DEFAULT_PARAMS, savedSetup, savedParameters, savedPlayback, scCycleSettings} =
    typeof module === "object" && module.exports ? require("./model.js") : Petri;
  const PRESET_EXTENSION = ".evoset";
  const PRESET_EXTENSIONS = Object.freeze([PRESET_EXTENSION, ".petripreset"]);
  const FORMAT = "petri-dish-preset";
  const VERSION = 1;

  function createPreset(name, settings) {
    name = typeof name === "string" ? name.trim() : "";
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error("Enter a preset name of 1 to 80 characters.");
    }
    const setup = savedSetup(settings?.setup);
    const params = savedParameters(settings.params);
    const playback = savedPlayback(settings.playback);
    const scCycle = scCycleSettings(settings.scCycle);
    if (!playback || scCycle.searchLength === undefined) {
      throw new Error("The preset is missing playback or SC Cycle settings.");
    }
    return {
      format: FORMAT, version: VERSION, name,
      settings: {setup, params: {...DEFAULT_PARAMS, ...params, ...scCycle.consolidation}, scCycle, playback},
    };
  }

  function loadPreset(data) {
    if (data?.format !== FORMAT || data.version !== VERSION) {
      throw new Error("This file is not a supported Petri Dish preset.");
    }
    return createPreset(data.name, data.settings);
  }

  function presetExtension(name) {
    const filename = name.toLowerCase();
    return PRESET_EXTENSIONS.find(extension => filename.endsWith(extension));
  }

  function presetFilename(name) {
    const base = name.replace(/[<>:"/\\|?*]/g, "-").replace(/[. ]+$/, "");
    const extension = presetExtension(base);
    const stem = extension ? base.slice(0, -extension.length).replace(/[. ]+$/, "") : base;
    return (stem || "settings") + PRESET_EXTENSION;
  }

  return {PRESET_EXTENSION, PRESET_EXTENSIONS, createPreset, loadPreset, presetExtension, presetFilename};
})();

if (typeof module === "object" && module.exports) module.exports = PetriPreset;
