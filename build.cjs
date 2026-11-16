"use strict";

const fs = require("node:fs");
const path = require("node:path");
const model = require("./src/model.js");
const root = __dirname;
const read = name => fs.readFileSync(path.join(root, "src", name), "utf8");
const config = {};
for (const name of ["ACTIVITIES", "COEFFICIENTS", "DEFAULT_SETUP", "DEFAULT_PARAMS", "DEFAULT_PAUSE_TICK"]) {
  config[name] = model[name];
}
const inline = {
  STYLE: read("style.css"),
  WORKER: read("model.js") + "\n" + read("worker.js"),
  APP: "const CONFIG = " + JSON.stringify(config) + ";\n" + read("app.js"),
};
const output = read("index.html").replace(/%%(STYLE|WORKER|APP)%%/g, (_, name) => inline[name]);
const outputDir = path.join(root, "docs");
fs.mkdirSync(outputDir, {recursive: true});
fs.writeFileSync(path.join(outputDir, "index.html"), output);
