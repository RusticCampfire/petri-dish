# Petri Dish Evolution Simulator

The current stable release is **v0.3**.

Petri Dish models a population evolving on a hexagonal grid. Adjust model parameters, try different food presets, inspect individual entities, and export run data as JSON.

[Open the stable simulator](https://rusticcampfire.github.io/petri-dish/)

[Read the model specification](SPECIFICATION.md)

## Run locally

Open `docs/index.html` in a browser. The simulator runs in the page.

## Build and test

```sh
node build.cjs
node --test test/*.test.cjs
```

The build generates `docs/index.html`. GitHub Pages serves the current stable build from `main` at `/docs`.
