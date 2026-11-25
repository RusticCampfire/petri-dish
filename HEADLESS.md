# Petri Dish in Node.js

Download the **Node.js kit** from the simulator footer and extract it into an empty folder. Open a terminal in that folder. The kit uses Node.js 22 or later and has no package dependencies.

## Start or continue a run

Start a dish with the usual defaults and save it at tick 1,000.

```sh
node run.cjs --ticks 1000 --out dish.json.gz
```

To continue a browser run, choose **Export results** in the simulator and supply the downloaded file to the runner. For example, this command loads tick 1,000, advances another 2,000 ticks, and saves tick 3,000.

```sh
node run.cjs --load dish.json.gz --ticks 2000 --out continued.json.gz
```

Choose **Import run** in the simulator to open `continued.json.gz`. The population, full tick history and settings travel with the file. Any queued parameter or gene-switch edits take effect on the first additional tick. The runner uses the requested tick count and preserves browser playback settings for your return.

Both plain `.json` and compressed `.json.gz` saves work in either direction. Use `--ticks 0` to inspect a checkpoint. Omit `--out` to print just the final tick and population. An explicit output path is replaced after writing succeeds.

The model keeps the full tick history in memory while it runs. The runner reads and writes save files in chunks.

## Use the model in your own script

`model.js` also works on its own. Place it beside a CommonJS script such as `experiment.cjs`.

```js
const {Simulation} = require("./model.js");
const dish = new Simulation({params: {foodMean: 1.5, foodSD: 8}});

for (let i = 0; i < 100; i++) dish.step();
const {tick, population, mass} = dish.history.at(-1);
console.log({tick, population, biomass: mass});
```

`dish.step()` advances one tick and returns its statistics. `dish.queueParameters(changes)` and `dish.queueGeneSwitches(changes)` schedule live edits for the next tick. `dish.exportResults()` returns checkpoint data, and `Simulation.fromResults(data)` restores it. Each new tick draws fresh randomness, just as it does in the browser.

An ES module can use the kit with `import model from "./model.js"`, then `const {Simulation} = model`. If you move just the source into a package with `"type": "module"`, name the file `model.cjs` and import it using that filename.

## Search–Consolidation Cycle

Pass `scCycle: {period: 2500, searchLength: 675, transitionLength: 250}` to `new Simulation()` to configure the cycle in ticks. Transition length covers both directions, and consolidation fills the rest of the period. A search length of zero uses the consolidation parameters throughout. Set the five copying parameters in `search` and `consolidation`. Existing proportion-based options and checkpoints still work.

`dish.queueScCycle(changes)` applies edits at the next tick boundary. An enabled cycle begins at its first active tick and each active history row reports its phase and effective genetic settings in `scCycle`. A checkpoint retains its settings, position and queued edits.

## Build the website from the repository

Run `node build.cjs` for the static site in `dist/`. For a stable GitHub Pages release, run `node build.cjs --pages` and include the generated `docs/` files in the release commit. Both builds serve the readable model at `./model.js` and include the Node.js kit and the self-contained offline page.
