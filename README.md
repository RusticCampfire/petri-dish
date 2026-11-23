# Petri Dish Evolution Simulator

The current stable release is **v0.4.1**.

Petri Dish models a population evolving on a hexagonal grid. Adjust model parameters, try different food presets, inspect individual entities, and save and resume runs.

[Open the stable simulator](https://rusticcampfire.github.io/petri-dish/)

[Read the model specification](SPECIFICATION.md)

## Run locally

Open `docs/petri-dish.html` in a browser for a self-contained copy.

## Run in Node.js

Download the [Node.js kit](https://rusticcampfire.github.io/petri-dish/petri-dish-node.tar.gz) and extract it into an empty folder. It works with Node.js 22 or later. The browser and Node.js share the same readable [model source](src/model.js) and can open each other's saved runs.

```sh
node run.cjs --ticks 1000 --out dish.json.gz
node run.cjs --load dish.json.gz --ticks 5000 --out continued.json.gz
```

[Read the headless guide](HEADLESS.md)

## Build and test

```sh
node build.cjs --pages
node --test test/*.test.cjs
```

The build uses Node.js and `tar`. GitHub Pages serves the current stable build from `main` at `/docs`.
