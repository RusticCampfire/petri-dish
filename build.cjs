"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {parseArgs} = require("node:util");
const {VERSION} = require("./src/model.js");

const {values} = parseArgs({options: {pages: {type: "boolean"}}});
const source = path.join(__dirname, "src");
const output = path.join(__dirname, values.pages ? "docs" : "dist");
const read = name => fs.readFileSync(path.join(source, name), "utf8");
const template = read("index.html");
const style = read("style.css");

function writePage(filename, scripts, downloads = "") {
  const substitutions = {VERSION, STYLE: style, SCRIPTS: scripts, DOWNLOADS: downloads};
  const html = template.replace(/%%(VERSION|STYLE|SCRIPTS|DOWNLOADS)%%/g, (_, key) => substitutions[key]);
  fs.writeFileSync(path.join(output, filename), html);
}

fs.mkdirSync(output, {recursive: true});
for (const file of ["model.js", "run-file.js", "worker.js", "preset-file.js", "app.js"]) {
  fs.copyFileSync(path.join(source, file), path.join(output, file));
}

writePage("index.html", `<script src="./model.js"></script>
  <script src="./preset-file.js"></script>
  <script src="./app.js"></script>`, `    <nav class="downloads" aria-label="Simulator downloads">
      <a href="./model.js" download>Model source</a>
      <a href="./petri-dish-node.tar.gz" download>Node.js kit</a>
      <a href="./petri-dish.html" download>Offline simulator</a>
    </nav>`);

// Keep the downloadable HTML self-contained, using the very same sources.
writePage("petri-dish.html", `<script id="model-source">${read("model.js")}</script>
  <script type="text/plain" id="worker-source">${read("run-file.js")}\n${read("worker.js")}</script>
  <script>${read("preset-file.js")}</script>
  <script>${read("app.js")}</script>`);

execFileSync("tar", ["-czf", path.join(output, "petri-dish-node.tar.gz"),
  "-C", source, "model.js", "run-file.js", "run.cjs", "package.json", "-C", __dirname, "HEADLESS.md"]);
if (values.pages) fs.writeFileSync(path.join(output, ".nojekyll"), "");
