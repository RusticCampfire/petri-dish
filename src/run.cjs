"use strict";

const {createWriteStream, openAsBlob} = require("node:fs");
const {mkdtemp, rename, rm} = require("node:fs/promises");
const {dirname, join} = require("node:path");
const {Readable} = require("node:stream");
const {pipeline} = require("node:stream/promises");
const {parseArgs} = require("node:util");
const {Simulation, savedPlayback} = require("./model.js");
const {createRunStream, readRunFile} = require("./run-file.js");

const usage = `node run.cjs --ticks N [--load FILE] [--out FILE]

  --ticks N    Advance N additional ticks. Use 0 to inspect or copy a save.
  --load FILE  Continue a browser or Node run (.json or .json.gz).
  --out FILE   Write a checkpoint. A .gz suffix selects gzip compression.
  --help       Show this help.

With no input file, the simulation starts with its usual defaults.
With no output file, the command prints the final tick and population.`;

async function saveCheckpoint(output, data) {
  // Write alongside the destination so a completed save can replace it atomically.
  const staging = await mkdtemp(join(dirname(output), ".petri-save-"));
  try {
    const temporary = join(staging, "run");
    const compress = output.toLowerCase().endsWith(".gz");
    const {stream, gzip} = createRunStream(data, compress);
    if (compress && !gzip) throw new Error("Gzip encoding is unavailable.");
    await pipeline(Readable.fromWeb(stream), createWriteStream(temporary));
    await rename(temporary, output);
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}

async function main() {
  const {values} = parseArgs({options: {
    ticks: {type: "string"}, load: {type: "string"}, out: {type: "string"},
    help: {type: "boolean", short: "h"},
  }});
  if (values.help) {
    console.log(usage);
    return;
  }
  const ticks = Number(values.ticks);
  if (!/^\d+$/.test(values.ticks ?? "") || !Number.isSafeInteger(ticks)) {
    throw new Error("--ticks must be a nonnegative whole number. See --help for usage.");
  }
  let simulation;
  let playback;
  if (values.load !== undefined) {
    const saved = await readRunFile(await openAsBlob(values.load));
    simulation = Simulation.fromResults(saved);
    playback = savedPlayback(saved.checkpoint?.playback);
  } else {
    simulation = new Simulation();
  }

  const target = simulation.tick + ticks;
  if (!Number.isSafeInteger(target)) throw new Error("The final tick exceeds the supported range.");
  while (simulation.tick < target) simulation.step();
  if (values.out !== undefined) {
    const result = simulation.exportResults();
    if (playback) result.checkpoint.playback = playback;
    await saveCheckpoint(values.out, result);
  }
  console.log(`Tick ${simulation.tick} · population ${simulation.entities.length}`);
  if (values.out !== undefined) console.log(`Saved ${values.out}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
