"use strict";

const PetriRunFile = (() => {
  const BLOCK_SIZE = 256 * 1024;
  // Every saved history row and entity is its own JSON value.
  const MAX_VALUE_LENGTH = 16 * 1024 * 1024;

  function* jsonParts(fields) {
    yield "{";
    for (let i = 0; i < fields.length; i++) {
      const {key, value, length} = fields[i];
      yield (i ? ",\n" : "\n") + JSON.stringify(key) + ":";
      if (length === null) {
        yield JSON.stringify(value);
        continue;
      }
      yield "[";
      for (let j = 0; j < length; j++) {
        yield (j ? ",\n" : "\n") + JSON.stringify(value[j]);
      }
      yield "]";
    }
    yield "\n}\n";
  }

  function createRunStream(data, compress) {
    // History and change logs are append-only. Capture their lengths at the saved tick.
    const fields = Object.entries(data).map(([key, value]) => ({
      key, value, length: Array.isArray(value) ? value.length : null,
    }));
    const parts = jsonParts(fields);
    const encoder = new TextEncoder();
    let blocks = 0;
    const json = new ReadableStream({
      async pull(controller) {
        // Give playback messages and ticks time between groups of export blocks.
        if (++blocks % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        let block = "";
        while (block.length < BLOCK_SIZE) {
          const part = parts.next();
          if (part.done) {
            if (block) controller.enqueue(encoder.encode(block));
            controller.close();
            return;
          }
          block += part.value;
        }
        controller.enqueue(encoder.encode(block));
      },
    });
    const gzip = compress && typeof CompressionStream === "function";
    const stream = gzip ? json.pipeThrough(new CompressionStream("gzip")) : json;
    return {stream, gzip};
  }

  async function saveRunFile(data, compress) {
    const {stream, gzip} = createRunStream(data, compress);
    const type = gzip ? "application/gzip" : "application/json";
    return {blob: await new Response(stream, {headers: {"Content-Type": type}}).blob(), gzip};
  }

  // Split the outer object and its arrays into values. JSON.parse validates each
  // complete value, so even an old one-line export can be read without a giant string.
  class RunReader {
    constructor(stream) {
      this.reader = stream.getReader();
      this.decoder = new TextDecoder("utf-8", {fatal: true});
      this.text = "";
      this.offset = 0;
      this.ended = false;
    }

    async fill() {
      while (!this.ended) {
        const {done, value} = await this.reader.read();
        this.ended = done;
        this.offset = 0;
        this.text = done ? this.decoder.decode() : this.decoder.decode(value, {stream: true});
        if (this.text.length) return true;
      }
      return false;
    }

    async peek() {
      while (this.offset < this.text.length || await this.fill()) {
        const char = this.text[this.offset];
        if (char !== " " && char !== "\t" && char !== "\r" && char !== "\n") return char;
        this.offset++;
      }
      return "";
    }

    async take(expected) {
      if (await this.peek() !== expected) throw new SyntaxError("Invalid JSON in the run file.");
      this.offset++;
    }

    async value() {
      const parts = [];
      let length = 0;
      let depth = 0;
      let inString = false;
      let escaped = false;
      while (this.offset < this.text.length || await this.fill()) {
        const start = this.offset;
        for (; this.offset < this.text.length; this.offset++) {
          const char = this.text[this.offset];
          if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
          } else if (char === '"') {
            inString = true;
          } else if (char === "{" || char === "[") {
            depth++;
          } else if (!depth && (char === "," || char === "]" || char === "}" || char === ":")) {
            break;
          } else if (char === "}" || char === "]") {
            depth--;
          }
        }
        length += this.offset - start;
        if (length > MAX_VALUE_LENGTH) throw new Error("A record in this run file is too large.");
        parts.push(this.text.slice(start, this.offset));
        if (this.offset < this.text.length) return JSON.parse(parts.join(""));
      }
      throw new SyntaxError("The run file ended before a complete value was read.");
    }

    async array() {
      await this.take("[");
      const items = [];
      if (await this.peek() !== "]") {
        do {
          items.push(await this.value());
          if (await this.peek() !== ",") break;
          this.offset++;
        } while (true);
      }
      await this.take("]");
      return items;
    }

    async read() {
      const data = Object.create(null);
      await this.take("{");
      if (await this.peek() !== "}") {
        do {
          const key = await this.value();
          if (typeof key !== "string" || Object.hasOwn(data, key)) {
            throw new SyntaxError("Invalid field in the run file.");
          }
          await this.take(":");
          data[key] = await this.peek() === "[" ? await this.array() : await this.value();
          if (await this.peek() !== ",") break;
          this.offset++;
        } while (true);
      }
      await this.take("}");
      if (await this.peek()) throw new SyntaxError("Unexpected data after the run file.");
      return data;
    }
  }

  async function readRunFile(file) {
    const prefix = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    let stream = file.stream();
    if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
      if (typeof DecompressionStream !== "function") throw new Error("Gzip decoding is unavailable.");
      stream = stream.pipeThrough(new DecompressionStream("gzip"));
    }
    const input = new RunReader(stream);
    try {
      return await input.read();
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The run file is incomplete or contains invalid JSON.");
      throw error;
    } finally {
      await input.reader.cancel().catch(() => {});
      input.reader.releaseLock();
    }
  }

  return {saveRunFile, readRunFile, createRunStream};
})();

if (typeof module === "object" && module.exports) module.exports = PetriRunFile;
