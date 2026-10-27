import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// editor/src/errors.mjs
var EditorError;
var init_errors = __esm({
  "editor/src/errors.mjs"() {
    EditorError = class extends Error {
      constructor(code, message, details2) {
        super(message);
        this.code = code;
        this.details = details2;
        this.name = "EditorError";
      }
    };
  }
});

// editor/src/engine.mjs
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}
function hasTerminalPrompt(value) {
  return /(?:^|\n)pen > $/.test(stripAnsi(value).replaceAll("\r", ""));
}
function details(stdout, stderr) {
  return { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
}
function warningsFrom(stderr) {
  return stripAnsi(stderr).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function fontBarrier(dir) {
  return `{const roots=Get((n,c)=>{if(c.depth===0){c.skipChildren();const b=c.bounds;if(b.width>0&&b.height>0)return {id:n.id,scale:Math.min(1,8/Math.min(b.width,b.height))};}});if(roots.length)Export([roots[0].id],'png',${JSON.stringify(dir)},{scale:roots[0].scale});}
`;
}
function decodeReply({ stdout, stderr, nonce }) {
  const clean = stripAnsi(stdout).replaceAll("\r", "");
  const markers = [];
  let malformedCurrent = false;
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && typeof value.bridge === "string") {
        markers.push(value);
      }
    } catch {
      if (line.includes(`"bridge":"${nonce}"`)) malformedCurrent = true;
    }
  }
  if (malformedCurrent || markers.some((marker2) => marker2.bridge !== nonce)) {
    throw new EditorError("ENGINE_PROTOCOL", "Ambiguous engine reply", details(stdout, stderr));
  }
  const marker = markers.find((value) => value.bridge === nonce);
  if (!marker) {
    const rejected = stderr.trim() || /\b(?:error|failed|rejected)\b/i.test(clean);
    throw new EditorError(
      rejected ? "ENGINE_REJECTED" : "ENGINE_PROTOCOL",
      rejected ? "Engine rejected execute" : "Engine reply has no current marker",
      details(stdout, stderr)
    );
  }
  return { value: marker.value, warnings: warningsFrom(stderr) };
}
function closedError() {
  return new EditorError("ENGINE_CLOSED", "Engine is closed");
}
async function startEngine({ argv, input, output, timeout_ms = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string")) {
    throw new EditorError("ENGINE_INPUT", "argv must be a nonempty string array");
  }
  if (typeof input !== "string" || typeof output !== "string") {
    throw new EditorError("ENGINE_INPUT", "input and output must be strings");
  }
  const child = spawn(argv[0], [...argv.slice(1), "interactive", "-i", input, "-o", output], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const engine = new Engine(child, timeout_ms);
  try {
    await engine.ready();
    return engine;
  } catch (error) {
    await engine.close();
    throw error;
  }
}
var ANSI_PATTERN, DEFAULT_TIMEOUT_MS, CLOSE_TIMEOUT_MS, EXEC_KINDS, Engine;
var init_engine = __esm({
  "editor/src/engine.mjs"() {
    init_errors();
    ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
    DEFAULT_TIMEOUT_MS = 12e4;
    CLOSE_TIMEOUT_MS = 2e3;
    EXEC_KINDS = /* @__PURE__ */ new Set(["mutate", "read", "measure"]);
    Engine = class {
      #child;
      #timeoutMs;
      #stdoutDecoder = new StringDecoder("utf8");
      #stderrDecoder = new StringDecoder("utf8");
      #startup = { stdout: "", stderr: "" };
      #pending = null;
      #alive = true;
      #accepting = true;
      #active = false;
      #queued = 0;
      #queue = Promise.resolve();
      #exitPromise;
      #resolveExit;
      #terminatePromise = null;
      #closePromise = null;
      #fontsStale = true;
      constructor(child, timeoutMs) {
        this.#child = child;
        this.#timeoutMs = timeoutMs;
        this.#exitPromise = new Promise((resolve3) => {
          this.#resolveExit = resolve3;
        });
        child.stdout.on("data", (chunk) => this.#onStdout(this.#stdoutDecoder.write(chunk)));
        child.stderr.on("data", (chunk) => this.#onStderr(this.#stderrDecoder.write(chunk)));
        child.once("error", (error) => this.#onFailure(new EditorError("ENGINE_START", "Engine process failed", { cause: error.message })));
        child.once("exit", (code, signal) => this.#onExit(code, signal));
      }
      /** @returns {number|undefined} */
      get pid() {
        return this.#child.pid;
      }
      async ready() {
        if (hasTerminalPrompt(this.#startup.stdout)) return;
        await this.#waitForPrompt(null);
      }
      #onStdout(text) {
        if (this.#pending) {
          this.#pending.stdout += text;
          if (hasTerminalPrompt(this.#pending.stdout)) this.#settlePending();
          return;
        }
        this.#startup.stdout += text;
      }
      #onStderr(text) {
        if (this.#pending) {
          this.#pending.stderr += text;
          return;
        }
        this.#startup.stderr += text;
      }
      #onFailure(error) {
        this.#alive = false;
        this.#accepting = false;
        this.#rejectPending(error);
        this.#resolveExit();
      }
      #onExit(code, signal) {
        const stdoutTail = this.#stdoutDecoder.end();
        const stderrTail = this.#stderrDecoder.end();
        if (stdoutTail) this.#onStdout(stdoutTail);
        if (stderrTail) this.#onStderr(stderrTail);
        this.#alive = false;
        this.#accepting = false;
        this.#rejectPending(new EditorError("ENGINE_EOF", "Engine exited before completing the reply", {
          code,
          signal,
          ...details(this.#pending?.stdout ?? this.#startup.stdout, this.#pending?.stderr ?? this.#startup.stderr)
        }));
        this.#resolveExit();
      }
      #settlePending() {
        const pending = this.#pending;
        if (!pending) return;
        this.#pending = null;
        clearTimeout(pending.timer);
        pending.resolve({ stdout: pending.stdout, stderr: pending.stderr });
      }
      #rejectPending(error) {
        const pending = this.#pending;
        if (!pending) return;
        this.#pending = null;
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      #waitForPrompt(line) {
        if (!this.#alive) return Promise.reject(closedError());
        if (this.#pending) {
          return Promise.reject(new EditorError("ENGINE_PROTOCOL", "Engine already has a pending command"));
        }
        return new Promise((resolve3, reject) => {
          const pending = { stdout: "", stderr: "", resolve: resolve3, reject, timer: null };
          if (line === null) {
            pending.stdout = this.#startup.stdout;
            pending.stderr = this.#startup.stderr;
            this.#startup = { stdout: "", stderr: "" };
          }
          pending.timer = setTimeout(() => {
            if (this.#pending !== pending) return;
            this.#pending = null;
            reject(new EditorError("ENGINE_TIMEOUT", "Engine command timed out", details(pending.stdout, pending.stderr)));
            void this.#terminate();
          }, this.#timeoutMs);
          this.#pending = pending;
          if (hasTerminalPrompt(pending.stdout)) {
            this.#settlePending();
            return;
          }
          if (line !== null) {
            this.#child.stdin.write(`${line}
`, (error) => {
              if (error && this.#pending === pending) {
                this.#rejectPending(new EditorError("ENGINE_EOF", "Could not write to engine", { cause: error.message }));
              }
            });
          }
        });
      }
      #enqueue(operation) {
        if (!this.#accepting) return Promise.reject(closedError());
        this.#queued += 1;
        const result = this.#queue.then(async () => {
          this.#queued -= 1;
          if (!this.#accepting) throw closedError();
          this.#active = true;
          try {
            return await operation();
          } finally {
            this.#active = false;
          }
        });
        this.#queue = result.catch(() => {
        });
        return result;
      }
      #terminate() {
        if (this.#terminatePromise) return this.#terminatePromise;
        this.#accepting = false;
        this.#terminatePromise = (async () => {
          if (!this.#alive) {
            await this.#exitPromise;
            return;
          }
          try {
            this.#child.kill();
          } catch {
          }
          let timer;
          await Promise.race([
            this.#exitPromise,
            new Promise((resolve3) => {
              timer = setTimeout(resolve3, CLOSE_TIMEOUT_MS);
            })
          ]);
          clearTimeout(timer);
          if (!this.#alive) return;
          try {
            this.#child.kill("SIGKILL");
          } catch {
          }
          await this.#exitPromise;
        })();
        return this.#terminatePromise;
      }
      async #execute(body, kind) {
        const nonce = randomUUID();
        if (kind === "mutate") this.#fontsStale = true;
        const barrier = kind === "measure" && this.#fontsStale;
        let dir;
        if (barrier) {
          try {
            dir = await mkdtemp(join(tmpdir(), "pen-fonts-"));
          } catch (cause) {
            throw new EditorError("ENGINE_FONTS", "Could not prepare the font wait", { cause: cause.message });
          }
        }
        try {
          const input = `const value = (() => {${barrier ? fontBarrier(dir) : ""}${body}
})();Print({bridge:${JSON.stringify(nonce)},value});`;
          const reply2 = await this.#waitForPrompt(`execute(${JSON.stringify({ input })})`);
          const decoded = decodeReply({ ...reply2, nonce });
          if (barrier) this.#fontsStale = false;
          return decoded;
        } catch (error) {
          await this.#terminate();
          throw error;
        } finally {
          if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
          });
        }
      }
      /**
       * Run one body in the engine.
       * `kind` says what the body may do to the document: `mutate` (default) may change it, including text, so the
       * next measuring read waits for fonts again; `read` leaves it untouched; `measure` is a read of node bounds and
       * only runs once every font the document needs has loaded, so no bound comes from a stand-in font.
       * @param {string} body
       * @param {{kind?:'mutate'|'read'|'measure'}} [options]
       * @returns {Promise<{value:any,warnings:string[]}>}
       */
      exec(body, { kind = "mutate" } = {}) {
        if (typeof body !== "string") {
          return Promise.reject(new EditorError("ENGINE_INPUT", "Execute body must be a string"));
        }
        if (!EXEC_KINDS.has(kind)) {
          return Promise.reject(new EditorError("ENGINE_INPUT", "Execute kind must be mutate, read or measure"));
        }
        return this.#enqueue(() => this.#execute(body, kind));
      }
      async #command(line) {
        try {
          const reply2 = await this.#waitForPrompt(line);
          const clean = stripAnsi(reply2.stdout);
          if (reply2.stderr.trim() || /^\[ERROR\]/mi.test(clean)) {
            throw new EditorError("ENGINE_REJECTED", "Engine rejected command", details(reply2.stdout, reply2.stderr));
          }
          return stripAnsi(reply2.stdout).replace(/(?:^|\n)pen > $/, "").trim();
        } catch (error) {
          await this.#terminate();
          throw error;
        }
      }
      /** @returns {Promise<void>} */
      async save() {
        await this.#enqueue(() => this.#command("save()"));
      }
      /** @returns {Promise<string>} */
      schema() {
        return this.#enqueue(() => this.#command(`read_skill(${JSON.stringify({ path: "pen-schema.md" })})`));
      }
      async #closeEngine() {
        const interrupted = this.#pending !== null || this.#active || this.#queued > 0 || this.#terminatePromise !== null;
        if (interrupted) {
          this.#rejectPending(closedError());
          await this.#terminate();
          await this.#queue;
          return;
        }
        if (!this.#alive) return;
        try {
          this.#child.stdin.write("exit()\n", () => {
          });
        } catch {
          await this.#terminate();
          return;
        }
        let timer;
        await Promise.race([
          this.#exitPromise,
          new Promise((resolve3) => {
            timer = setTimeout(resolve3, CLOSE_TIMEOUT_MS);
          })
        ]);
        clearTimeout(timer);
        if (this.#alive) await this.#terminate();
      }
      /** @returns {Promise<void>} */
      close() {
        if (this.#closePromise) return this.#closePromise;
        this.#accepting = false;
        this.#closePromise = this.#closeEngine();
        return this.#closePromise;
      }
    };
  }
});

// editor/src/history.mjs
function copyIndex(index) {
  return {
    ...index,
    snapshots: [...index.snapshots],
    sizes: { ...index.sizes }
  };
}
function retainedIds(index) {
  return /* @__PURE__ */ new Set([...index.snapshots, index.saved_id]);
}
function appendHistory(index, checkpoint) {
  if (typeof checkpoint.id !== "string" || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes < 0) {
    throw new EditorError("CHECKPOINT_INVALID", "Checkpoint metadata is invalid");
  }
  const next = copyIndex(index);
  next.snapshots = next.snapshots.slice(0, next.cursor + 1);
  next.snapshots.push(checkpoint.id);
  next.cursor = next.snapshots.length - 1;
  next.revision += 1;
  next.sizes[checkpoint.id] = checkpoint.bytes;
  const retained = retainedIds(next);
  for (const id of Object.keys(next.sizes)) {
    if (!retained.has(id)) delete next.sizes[id];
  }
  return next;
}
function seekHistory(index, direction) {
  if (direction !== "undo" && direction !== "redo") {
    throw new EditorError("HISTORY_DIRECTION_INVALID", "History direction must be undo or redo");
  }
  const next = copyIndex(index);
  if (direction === "undo") next.cursor = Math.max(0, next.cursor - 1);
  else next.cursor = Math.min(next.snapshots.length - 1, next.cursor + 1);
  return next;
}
var init_history = __esm({
  "editor/src/history.mjs"() {
    init_errors();
  }
});

// editor/src/layout.mjs
function layoutOf(node) {
  if (typeof node?.layout === "string") return node.layout;
  return node?.type === "frame" ? "horizontal" : "none";
}
function normalizeRow(row) {
  return { ...row, layout: layoutOf(row) };
}
function placedByLayout(parent, row) {
  return parent !== null && parent !== void 0 && layoutOf(parent) !== "none" && row.layout_position !== "absolute";
}
var init_layout = __esm({
  "editor/src/layout.mjs"() {
  }
});

// editor/src/model.mjs
function requirePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new EditorError("MODEL_PATH", "Node path must be a nonempty string");
  }
  return JSON.stringify(path);
}
async function readModel(engine) {
  const { value } = await engine.exec(`
const rootIds=Get((n,c)=>{if(c.depth===0){c.skipChildren();return n.id;}});
const roots=rootIds.map(id=>Get(id));
const rows=Get((n,c)=>{
 const b=c.bounds;
 return {path:n.id,parent_path:c.parentCtx?c.parentCtx.node.id:null,type:n.type,
  layout:typeof n.layout==='string'?n.layout:null,layout_position:n.layoutPosition,enabled:n.enabled,
  x:b.x,y:b.y,width:b.width,height:b.height};
},{resolveVariables:true,resolveInstances:true});
return {roots,rows,variables:GetVariables()};`, { kind: "measure" });
  if (!value || !Array.isArray(value.roots) || !Array.isArray(value.rows) || !value.variables) {
    throw new EditorError("MODEL_PROTOCOL", "Engine returned an invalid model");
  }
  return { ...value, rows: value.rows.map(normalizeRow) };
}
async function readNode(engine, path) {
  const literal = requirePath(path);
  const { value } = await engine.exec(`
const found=Get(${literal},(n,c)=>{
 c.skipChildren();
 const {children,...schema}=n;
 const b=c.bounds;
 return {...schema,path:n.id,parent_path:c.parentCtx?c.parentCtx.node.id:null,
  bounds:{x:b.x,y:b.y,width:b.width,height:b.height}};
},{resolveVariables:false,resolveInstances:true});
return found[0]||null;`, { kind: "measure" });
  return value ?? null;
}
async function readVariables(engine) {
  const { value } = await engine.exec("return GetVariables();", { kind: "read" });
  if (!value || typeof value !== "object" || !value.variables) {
    throw new EditorError("MODEL_PROTOCOL", "Engine returned invalid variables");
  }
  return value;
}
var init_model = __esm({
  "editor/src/model.mjs"() {
    init_errors();
    init_layout();
  }
});

// editor/src/ops.mjs
function invalid(message) {
  throw new EditorError("OPERATIONS_INVALID", message);
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertJson(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") invalid("Operation data must contain only JSON values");
  if (seen.has(value)) invalid("Operation data must not be cyclic");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid("Operation data must use plain objects");
    }
    for (const item of Object.values(value)) assertJson(item, seen);
  }
  seen.delete(value);
}
function assertPath(value, name) {
  if (typeof value !== "string" || value.length === 0) invalid(`${name} must be a nonempty string`);
}
function assertParent(value) {
  if (value !== null) assertPath(value, "parent");
}
function assertKeys(operation, allowed) {
  for (const key of Object.keys(operation)) {
    if (!allowed.has(key)) invalid(`Unknown ${operation.op} operation key`);
  }
}
function assertObject(value, name) {
  if (!isObject(value)) invalid(`${name} must be an object`);
  assertJson(value);
}
function validateOperation(operation) {
  if (!isObject(operation) || typeof operation.op !== "string") invalid("Operation must be an object with an op");
  assertJson(operation);
  const allowed = OPERATION_KEYS[operation.op];
  if (!allowed) invalid("Unknown operation");
  assertKeys(operation, allowed);
  switch (operation.op) {
    case "insert":
      if (!Object.hasOwn(operation, "parent")) invalid("insert requires parent");
      assertParent(operation.parent);
      assertObject(operation.node, "node");
      break;
    case "copy":
      assertPath(operation.path, "path");
      if (!Object.hasOwn(operation, "parent")) invalid("copy requires parent");
      assertParent(operation.parent);
      if (Object.hasOwn(operation, "data")) assertObject(operation.data, "data");
      break;
    case "update":
      assertPath(operation.path, "path");
      assertObject(operation.props, "props");
      break;
    case "replace":
      assertPath(operation.path, "path");
      assertObject(operation.node, "node");
      break;
    case "move":
      assertPath(operation.path, "path");
      if (Object.hasOwn(operation, "parent")) assertParent(operation.parent);
      if (Object.hasOwn(operation, "index") && (!Number.isSafeInteger(operation.index) || operation.index < 0)) {
        invalid("index must be a nonnegative safe integer");
      }
      break;
    case "delete":
      assertPath(operation.path, "path");
      break;
    case "set_variables":
      assertObject(operation.variables, "variables");
      if (Object.hasOwn(operation, "replace") && typeof operation.replace !== "boolean") {
        invalid("replace must be a boolean");
      }
      break;
  }
}
function compileOperations(operations) {
  if (!Array.isArray(operations)) invalid("operations must be an array");
  if (operations.length > MAX_OPERATIONS) {
    throw new EditorError("OPERATIONS_LIMIT", "A batch cannot exceed 100 operations");
  }
  for (const operation of operations) validateOperation(operation);
  const data = JSON.stringify(operations);
  if (Buffer.byteLength(data, "utf8") > MAX_OPERATION_BYTES) {
    throw new EditorError("OPERATIONS_LIMIT", "A batch cannot exceed 1 MiB");
  }
  return `const ops=JSON.parse(${JSON.stringify(data)});const created=[];
for(let i=0;i<ops.length;i++){
 const o=ops[i];
 switch(o.op){
  case 'insert':
   created.push({index:i,path:Insert(o.parent===null?document:o.parent,o.node)});break;
  case 'copy':
   created.push({index:i,path:Copy(o.path,o.parent===null?document:o.parent,o.data??{})});break;
  case 'update':
   Update(o.path,o.props);break;
  case 'replace':
   created.push({index:i,path:Replace(o.path,o.node)});break;
  case 'move': {
   const parent=Object.prototype.hasOwnProperty.call(o,'parent')
    ? (o.parent===null?document:o.parent) : undefined;
   Move(o.path,parent,o.index);break;
  }
  case 'delete':
   Delete(o.path);break;
  case 'set_variables':
   SetVariables(o.variables,o.replace??false);break;
  default:
   throw Error('Unknown operation');
 }
}
return {created};`;
}
var MAX_OPERATIONS, MAX_OPERATION_BYTES, OPERATION_KEYS;
var init_ops = __esm({
  "editor/src/ops.mjs"() {
    init_errors();
    MAX_OPERATIONS = 100;
    MAX_OPERATION_BYTES = 1024 * 1024;
    OPERATION_KEYS = {
      insert: /* @__PURE__ */ new Set(["op", "parent", "node"]),
      copy: /* @__PURE__ */ new Set(["op", "path", "parent", "data"]),
      update: /* @__PURE__ */ new Set(["op", "path", "props"]),
      replace: /* @__PURE__ */ new Set(["op", "path", "node"]),
      move: /* @__PURE__ */ new Set(["op", "path", "parent", "index"]),
      delete: /* @__PURE__ */ new Set(["op", "path"]),
      set_variables: /* @__PURE__ */ new Set(["op", "variables", "replace"])
    };
  }
});

// editor/src/system.mjs
import { win32 } from "node:path";
function systemTool(name, env = process.env) {
  if (!Object.hasOwn(TOOLS, name)) throw new Error(`Unknown system tool: ${name}`);
  return win32.join(env.SystemRoot || "C:\\Windows", "System32", TOOLS[name]);
}
var TOOLS;
var init_system = __esm({
  "editor/src/system.mjs"() {
    TOOLS = Object.freeze({
      whoami: "whoami.exe",
      icacls: "icacls.exe",
      taskkill: "taskkill.exe",
      powershell: "WindowsPowerShell\\v1.0\\powershell.exe"
    });
  }
});

// editor/src/save.mjs
import { spawn as spawn2 } from "node:child_process";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { once } from "node:events";
import { open, lstat, readFile, rename, stat, unlink } from "node:fs/promises";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { basename, dirname, isAbsolute, join as join2, resolve } from "node:path";
function saveError(code, message, details2) {
  return new EditorError(code, message, details2);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function artifactIdentity(details2) {
  return {
    dev: String(details2.dev),
    ino: String(details2.ino),
    size: String(details2.size)
  };
}
function isArtifactIdentity(identity) {
  return identity !== null && typeof identity === "object" && /^\d+$/.test(identity.dev) && /^\d+$/.test(identity.ino) && /^\d+$/.test(identity.size);
}
function sameIdentity(details2, identity) {
  return isArtifactIdentity(identity) && String(details2.dev) === identity.dev && String(details2.ino) === identity.ino && String(details2.size) === identity.size;
}
async function writeExclusiveDurable(path, data) {
  const handle = await open(path, "wx", 384);
  try {
    await handle.writeFile(data);
    await handle.sync();
    return artifactIdentity(await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
}
async function unlinkIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
async function captureArtifactIdentity(path) {
  const [followed, direct] = await Promise.all([
    stat(path, { bigint: true }),
    lstat(path, { bigint: true })
  ]);
  if (direct.isSymbolicLink() || !direct.isFile() || !followed.isFile() || String(direct.dev) !== String(followed.dev) || String(direct.ino) !== String(followed.ino)) {
    throw saveError("SAVE_ARTIFACT_INVALID", "Save artifact is not a regular file");
  }
  return artifactIdentity(followed);
}
async function removeOwnedArtifact(path, identity) {
  let details2;
  try {
    details2 = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { leftovers: [] };
    throw error;
  }
  if (details2.isSymbolicLink() || !details2.isFile() || !sameIdentity(details2, identity)) {
    return { leftovers: [path] };
  }
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { leftovers: [] };
}
async function regularFile(path, code) {
  let details2;
  try {
    details2 = await lstat(path);
  } catch (error) {
    throw saveError(code, "Save input is unavailable", { cause: error });
  }
  if (details2.isSymbolicLink() || !details2.isFile()) {
    throw saveError(code, "Save input must be a regular file");
  }
  return details2;
}
async function assertAbsent(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw saveError(code, "Save destination cannot be inspected", { cause: error });
  }
  throw saveError(code, "Save destination already exists");
}
function assertAbsolutePath(path, name) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw saveError("SAVE_MANIFEST_INVALID", `${name} must be an absolute path`);
  }
  return resolve(path);
}
async function validatePublishOptions(options) {
  const allowed = /* @__PURE__ */ new Set(["candidate", "original", "backup", "expected_hash", "script"]);
  if (!options || typeof options !== "object" || Object.keys(options).some((key) => !allowed.has(key)) || !HASH.test(options.expected_hash)) {
    throw saveError("SAVE_MANIFEST_INVALID", "Save manifest is invalid");
  }
  const candidate = assertAbsolutePath(options.candidate, "candidate");
  const original = assertAbsolutePath(options.original, "original");
  const backup = assertAbsolutePath(options.backup, "backup");
  const script = options.script === void 0 ? REPLACE_SCRIPT : assertAbsolutePath(options.script, "script");
  if ((/* @__PURE__ */ new Set([candidate.toLowerCase(), original.toLowerCase(), backup.toLowerCase()])).size !== 3 || dirname(candidate).toLowerCase() !== dirname(original).toLowerCase() || dirname(backup).toLowerCase() !== dirname(original).toLowerCase()) {
    throw saveError("SAVE_MANIFEST_INVALID", "Save paths must be distinct and share one directory");
  }
  const candidateDetails = await regularFile(candidate, "SAVE_CANDIDATE_INVALID");
  await regularFile(original, "SOURCE_CHANGED");
  await regularFile(script, "SAVE_MANIFEST_INVALID");
  await assertAbsent(backup, "SAVE_BACKUP_EXISTS");
  if (candidateDetails.size < 1) throw saveError("SAVE_CANDIDATE_INVALID", "Save candidate is incomplete");
  const candidateHash = sha256(await readFile(candidate));
  return {
    script,
    manifest: {
      candidate,
      original,
      backup,
      expected_hash: options.expected_hash,
      candidate_hash: candidateHash
    }
  };
}
function parseResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let result;
  try {
    result = JSON.parse(lines.at(-1));
  } catch (error) {
    throw saveError("SAVE_PROTOCOL", "Save helper returned invalid JSON", { cause: error, stdout });
  }
  if (!result || typeof result !== "object" || ![true, false, null].includes(result.published)) {
    throw saveError("SAVE_PROTOCOL", "Save helper returned an invalid outcome");
  }
  if (result.source_hash !== void 0 && !HASH.test(result.source_hash) || result.replaced_hash !== void 0 && !HASH.test(result.replaced_hash) || result.conflict !== void 0 && typeof result.conflict !== "boolean") {
    throw saveError("SAVE_PROTOCOL", "Save helper returned invalid hashes");
  }
  return result;
}
async function terminateChildTree(child) {
  let killer;
  if (process.platform === "win32" && Number.isInteger(child.pid)) {
    try {
      killer = spawn2(systemTool("taskkill"), ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      killer = void 0;
    }
  }
  child.kill();
  if (killer) await once(killer, "close").catch(() => void 0);
}
async function runReplace(manifestPath, script) {
  const child = spawn2(systemTool("powershell"), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Manifest",
    manifestPath
  ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let closed = false;
  let overflow = false;
  let termination;
  function stopChild() {
    if (!termination) termination = terminateChildTree(child);
    return termination;
  }
  function collect(chunk, target) {
    if (overflow) return;
    const bytes = Buffer.byteLength(chunk);
    if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
      overflow = true;
      void stopChild();
      return;
    }
    outputBytes += bytes;
    if (target === "stdout") stdout += chunk;
    else stderr += chunk;
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
  const timeout = setTimeout(() => {
    void stopChild();
  }, 12e4);
  try {
    const [code, signal] = await once(child, "close");
    closed = true;
    await termination;
    if (overflow) {
      throw saveError("SAVE_PROTOCOL", "Save helper output exceeded its limit", {
        captured_bytes: outputBytes,
        max_bytes: MAX_OUTPUT_BYTES
      });
    }
    if (!stdout.trim()) {
      throw saveError("SAVE_HELPER_FAILED", "Save helper returned no result", { code, signal, stderr });
    }
    return parseResult(stdout);
  } catch (error) {
    if (error?.code === "ENOENT") throw saveError("SAVE_HELPER_MISSING", "PowerShell is unavailable", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!closed) {
      await stopChild();
      await once(child, "close").catch(() => void 0);
    }
  }
}
async function publishWindows(options) {
  const { manifest, script } = await validatePublishOptions(options);
  const manifestPath = join2(dirname(manifest.candidate), `.tern-save-${randomUUID2()}.json`);
  let manifestIdentity;
  let result;
  let operationError;
  try {
    manifestIdentity = await writeExclusiveDurable(manifestPath, JSON.stringify(manifest));
    try {
      result = await runReplace(manifestPath, script);
      if (result.published === true) {
        result = { ...result, backup_identity: await captureArtifactIdentity(manifest.backup) };
      }
    } catch (error) {
      operationError = error;
    }
  } catch (error) {
    operationError = error;
  }
  let cleanup = { leftovers: [] };
  let cleanupError;
  if (manifestIdentity) {
    try {
      cleanup = await removeOwnedArtifact(manifestPath, manifestIdentity);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (operationError) {
    operationError.details = {
      ...operationError.details ?? {},
      leftovers: cleanup.leftovers,
      ...cleanupError ? { cleanup_error: cleanupError } : {}
    };
    throw operationError;
  }
  if (cleanupError) throw cleanupError;
  return { ...result, leftovers: cleanup.leftovers };
}
function candidatePath(original, sessionId) {
  return join2(dirname(original), `.${basename(original)}.tern-save-${sessionId}-${randomUUID2()}.candidate`);
}
function backupPath(original, sessionId) {
  return join2(dirname(original), `.${basename(original)}.tern-save-${sessionId}-${randomUUID2()}.bak`);
}
function intentPath(storeDir) {
  return join2(storeDir, INTENT_NAME);
}
function validateIntent(intent, original) {
  if (!intent || typeof intent !== "object" || intent.version !== 1 || intent.original_path !== original || typeof intent.session_id !== "string" || !HASH.test(intent.expected_hash) || !HASH.test(intent.candidate_hash) || !HASH.test(intent.checkpoint_id) || typeof intent.candidate_path !== "string" || !isArtifactIdentity(intent.candidate_identity) || typeof intent.backup_path !== "string" || intent.backup_identity !== void 0 && !isArtifactIdentity(intent.backup_identity)) {
    throw saveError("SAVE_INTENT_INVALID", "Pending Save intent is invalid");
  }
  const directory = dirname(original).toLowerCase();
  if (dirname(intent.candidate_path).toLowerCase() !== directory || dirname(intent.backup_path).toLowerCase() !== directory || !basename(intent.candidate_path).includes(`tern-save-${intent.session_id}-`) || !basename(intent.candidate_path).endsWith(".candidate") || !basename(intent.backup_path).includes(`tern-save-${intent.session_id}-`) || !basename(intent.backup_path).endsWith(".bak")) {
    throw saveError("SAVE_INTENT_INVALID", "Pending Save paths are not owned by the session");
  }
  return intent;
}
async function prepareSave({ bytes, original, session_id: sessionId, expected_hash: expectedHash, checkpoint_id: checkpointId }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || sha256(bytes) !== checkpointId || !HASH.test(expectedHash)) {
    throw saveError("SAVE_CANDIDATE_INVALID", "Confirmed checkpoint cannot form a Save candidate");
  }
  const candidate = candidatePath(original, sessionId);
  const backup = backupPath(original, sessionId);
  await assertAbsent(backup, "SAVE_BACKUP_EXISTS");
  const candidateIdentity = await writeExclusiveDurable(candidate, bytes);
  return {
    version: 1,
    session_id: sessionId,
    original_path: original,
    expected_hash: expectedHash,
    candidate_hash: checkpointId,
    checkpoint_id: checkpointId,
    candidate_path: candidate,
    candidate_identity: candidateIdentity,
    backup_path: backup
  };
}
async function writeSaveIntent(storeDir, intent, { replace = false } = {}) {
  const path = intentPath(storeDir);
  validateIntent(intent, intent.original_path);
  if (!replace) {
    try {
      await writeExclusiveDurable(path, JSON.stringify(intent));
      return;
    } catch (error) {
      if (error?.code === "EEXIST") throw saveError("SAVE_INTENT_PENDING", "A previous Save needs recovery");
      throw error;
    }
  }
  const pending = join2(storeDir, `${randomUUID2()}.save-intent-pending`);
  try {
    await writeExclusiveDurable(pending, JSON.stringify(intent));
    await rename(pending, path);
  } finally {
    await unlinkIfExists(pending);
  }
}
async function removeSaveIntent(storeDir) {
  await unlinkIfExists(intentPath(storeDir));
}
async function loadSaveIntent(storeDir, original) {
  let text;
  try {
    text = await readFile(intentPath(storeDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let intent;
  try {
    intent = JSON.parse(text);
  } catch (error) {
    throw saveError("SAVE_INTENT_INVALID", "Pending Save intent is unreadable", { cause: error });
  }
  return validateIntent(intent, original);
}
async function preserveCandidate(intent, bytes) {
  let existingIdentity;
  try {
    existingIdentity = await captureArtifactIdentity(intent.candidate_path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const candidateIdentity = await writeExclusiveDurable(intent.candidate_path, bytes);
    return { intent: { ...intent, candidate_identity: candidateIdentity }, leftovers: [] };
  }
  if (!sameIdentity({
    dev: BigInt(existingIdentity.dev),
    ino: BigInt(existingIdentity.ino),
    size: BigInt(existingIdentity.size)
  }, intent.candidate_identity)) {
    return { intent, leftovers: [intent.candidate_path] };
  }
  const existing = await readFile(intent.candidate_path);
  const verifiedIdentity = await captureArtifactIdentity(intent.candidate_path);
  if (JSON.stringify(verifiedIdentity) !== JSON.stringify(existingIdentity)) {
    return { intent, leftovers: [intent.candidate_path] };
  }
  if (sha256(existing) !== intent.candidate_hash) {
    throw saveError("SAVE_CANDIDATE_INVALID", "Preserved Save candidate changed");
  }
  return { intent, leftovers: [] };
}
async function removeCandidate(intent) {
  return removeOwnedArtifact(intent.candidate_path, intent.candidate_identity);
}
async function fileHash(path) {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function reconcileSaveIntent({ source, store, index }) {
  let intent = await loadSaveIntent(store.dir, source.original_path);
  if (!intent) return { index, recovery: null };
  const checkpoint = await store.read(intent.checkpoint_id);
  if (sha256(checkpoint) !== intent.candidate_hash) {
    throw saveError("SAVE_INTENT_INVALID", "Save intent checkpoint does not match its candidate");
  }
  const diskHash = source.source_fingerprint;
  const backupHash = await fileHash(intent.backup_path);
  if (backupHash !== null && !intent.backup_identity) {
    intent = { ...intent, backup_identity: await captureArtifactIdentity(intent.backup_path) };
  }
  if (intent.conflict === true || diskHash === intent.candidate_hash && backupHash !== intent.expected_hash) {
    const preserved2 = await preserveCandidate({
      ...intent,
      conflict: true,
      replaced_hash: backupHash
    }, checkpoint);
    await writeSaveIntent(store.dir, preserved2.intent, { replace: true });
    return {
      index,
      recovery: { save_conflict: true, leftovers: preserved2.leftovers },
      intent: preserved2.intent
    };
  }
  if (diskHash === intent.candidate_hash) {
    const next = await store.publish({
      ...index,
      saved_id: intent.checkpoint_id,
      source: { fingerprint: diskHash },
      save_backup: {
        path: intent.backup_path,
        owner_session_id: intent.session_id,
        identity: intent.backup_identity
      }
    });
    await source.acceptPublished(diskHash);
    await removeSaveIntent(store.dir);
    const cleanup = await removeCandidate(intent);
    return { index: next, recovery: null, leftovers: cleanup.leftovers };
  }
  const candidateHash = await fileHash(intent.candidate_path);
  if (diskHash === intent.expected_hash && candidateHash === intent.candidate_hash && backupHash === null) {
    await removeSaveIntent(store.dir);
    const cleanup = await removeCandidate(intent);
    return { index, recovery: null, leftovers: cleanup.leftovers };
  }
  const preserved = await preserveCandidate({
    ...intent,
    conflict: true,
    replaced_hash: backupHash
  }, checkpoint);
  await writeSaveIntent(store.dir, preserved.intent, { replace: true });
  return {
    index,
    recovery: { save_conflict: true, leftovers: preserved.leftovers },
    intent: preserved.intent
  };
}
async function createRecoveryCopy({ bytes, original, checkpoint_id: checkpointId }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || sha256(bytes) !== checkpointId) {
    throw saveError("RECOVERY_COPY_INVALID", "Recovery checkpoint is invalid");
  }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join2(dirname(original), `${basename(original, ".pen")}.tern-recovery-${randomUUID2()}.pen`);
    try {
      await writeExclusiveDurable(path, bytes);
      return { path, checkpoint_id: checkpointId };
    } catch (error) {
      if (error?.code !== "EEXIST") throw saveError("RECOVERY_COPY_FAILED", "Recovery copy could not be written", { cause: error });
    }
  }
  throw saveError("RECOVERY_COPY_FAILED", "A unique recovery copy name could not be reserved");
}
async function removePreviousBackup(index, sessionId, currentBackup, original) {
  const previous = index.save_backup;
  if (!previous || previous.owner_session_id !== sessionId || previous.path === currentBackup) {
    return { leftovers: [] };
  }
  if (dirname(previous.path).toLowerCase() !== dirname(original).toLowerCase() || !basename(previous.path).includes(`tern-save-${sessionId}-`) || !basename(previous.path).endsWith(".bak")) {
    return { leftovers: [] };
  }
  return removeOwnedArtifact(previous.path, previous.identity);
}
var HASH, INTENT_NAME, MAX_OUTPUT_BYTES, REPLACE_SCRIPT;
var init_save = __esm({
  "editor/src/save.mjs"() {
    init_errors();
    init_system();
    HASH = /^[a-f0-9]{64}$/;
    INTENT_NAME = "save-intent.json";
    MAX_OUTPUT_BYTES = 1024 * 1024;
    REPLACE_SCRIPT = fileURLToPath2(new URL(
      import.meta.url.endsWith("/save.mjs") ? "../windows/replace.ps1" : "./windows-replace.ps1",
      import.meta.url
    ));
  }
});

// editor/src/document.mjs
import { readFile as readFile2 } from "node:fs/promises";
function documentError(code, message, details2) {
  return new EditorError(code, message, details2);
}
function refusalReason(error) {
  const stderr = String(error.details?.stderr ?? "").replaceAll("\r", "");
  const block = /^\[error\][^\n]*(?:\n(?!\[|\s+at ).*)*/im.exec(stderr)?.[0] ?? "";
  const reason = block.split("[Error]: ").pop().replace(/^\[ERROR\]\s*/i, "").trim();
  return Array.from(reason).slice(0, 300).join("") || "The engine refused the operations";
}
function assertSource(source) {
  if (!source || typeof source.original_path !== "string" || typeof source.session_id !== "string" || typeof source.working_path !== "string" || typeof source.source_fingerprint !== "string" || typeof source.assertDiskBase !== "function" || typeof source.acceptPublished !== "function" || typeof source.restore !== "function" || typeof source.discardWorking !== "function" || typeof source.release !== "function") {
    throw documentError("DOCUMENT_OPTIONS_INVALID", "Source is incomplete");
  }
}
function assertStore(store) {
  if (!store || typeof store.dir !== "string" || typeof store.load !== "function" || typeof store.put !== "function" || typeof store.read !== "function" || typeof store.publish !== "function") {
    throw documentError("DOCUMENT_OPTIONS_INVALID", "Store is incomplete");
  }
}
function assertCliArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string")) {
    throw documentError("DOCUMENT_OPTIONS_INVALID", "cli_argv must be a nonempty string array");
  }
}
function assertDocumentSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DOCUMENT_BYTES) {
    throw documentError("DOCUMENT_LIMIT", "Document exceeds 64 MiB");
  }
}
function currentCheckpoint(index) {
  return index.snapshots[index.cursor];
}
function assertSaveRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => key !== "session_id" && key !== "base_revision")) {
    throw documentError("SAVE_REQUEST_INVALID", "Save request contains unsupported fields");
  }
}
function expiredFacadeError() {
  return documentError("ENGINE_FACADE_EXPIRED", "Engine facade is no longer active");
}
function createEngineFacade(engine) {
  let active = true;
  let execCalled = false;
  const pending = /* @__PURE__ */ new Set();
  function invoke(operation) {
    if (!active) return Promise.reject(expiredFacadeError());
    let promise;
    try {
      promise = Promise.resolve(operation());
    } catch (error) {
      promise = Promise.reject(error);
    }
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise)
    );
    return promise;
  }
  const facade = /* @__PURE__ */ Object.create(null);
  Object.defineProperties(facade, {
    exec: {
      enumerable: true,
      value(body, options) {
        if (!active) return Promise.reject(expiredFacadeError());
        execCalled = true;
        return invoke(() => engine.exec(body, options));
      }
    },
    schema: {
      enumerable: true,
      value() {
        return invoke(() => engine.schema());
      }
    }
  });
  return {
    facade: Object.freeze(facade),
    didExec: () => execCalled,
    async expire() {
      active = false;
      await Promise.allSettled([...pending]);
    }
  };
}
function initialIndex(source, checkpoint) {
  return {
    version: 1,
    source: { fingerprint: source.source_fingerprint },
    snapshots: [checkpoint.id],
    cursor: 0,
    saved_id: checkpoint.id,
    revision: 0,
    sizes: { [checkpoint.id]: checkpoint.bytes }
  };
}
async function openDocument({ source, store, cli_argv: cliArgv, recovery }) {
  assertSource(source);
  assertStore(store);
  assertCliArgv(cliArgv);
  if (recovery !== "prompt") {
    throw documentError("DOCUMENT_OPTIONS_INVALID", "Only prompt recovery is available");
  }
  let engine;
  try {
    const sourceBytes = await readFile2(source.working_path);
    assertDocumentSize(sourceBytes);
    let index = await store.load();
    let phase = "ready";
    let recoveryInfo;
    let recoverySaveIntent;
    let model = null;
    if (index) {
      const reconciliation = await reconcileSaveIntent({ source, store, index });
      index = reconciliation.index;
      recoverySaveIntent = reconciliation.intent;
      const checkpointBytes = await store.read(currentCheckpoint(index));
      assertDocumentSize(checkpointBytes);
      await source.restore(checkpointBytes);
      engine = await startEngine({
        argv: cliArgv,
        input: source.working_path,
        output: source.working_path,
        timeout_ms: 12e4
      });
      model = await readModel(engine);
      const nothingToRecover = !reconciliation.recovery && !reconciliation.intent && currentCheckpoint(index) === index.saved_id && index.source.fingerprint === source.source_fingerprint;
      if (!nothingToRecover) {
        index = await store.publish({ ...index, revision: index.revision + 1 });
        phase = "recovering";
        recoveryInfo = {
          source_matches: index.source.fingerprint === source.source_fingerprint,
          // Only an adopted orphan lock means the previous owner never closed.
          previous_owner_lost: source.adopted_orphan === true,
          ...reconciliation.recovery ?? {}
        };
      }
    } else {
      engine = await startEngine({
        argv: cliArgv,
        input: source.working_path,
        output: source.working_path,
        timeout_ms: 12e4
      });
      await engine.save();
      const normalized = await readFile2(source.working_path);
      assertDocumentSize(normalized);
      const checkpoint = await store.put(normalized);
      index = await store.publish(initialIndex(source, checkpoint));
    }
    return new DocumentSession({
      source,
      store,
      cliArgv,
      engine,
      index,
      phase,
      recovery: recoveryInfo,
      recoverySourceBytes: recoveryInfo ? sourceBytes : void 0,
      recoverySaveIntent,
      model
    });
  } catch (error) {
    const cleanup = [];
    try {
      await engine?.close();
      await source.discardWorking();
    } catch (cleanupError) {
      cleanup.push(cleanupError);
    }
    try {
      await source.release();
    } catch (cleanupError) {
      cleanup.push(cleanupError);
    }
    if (cleanup.length > 0 && error && typeof error === "object" && Object.isExtensible(error)) {
      Object.defineProperty(error, "cleanup_failures", { value: cleanup, configurable: true });
    }
    throw error;
  }
}
var MAX_DOCUMENT_BYTES, DocumentSession;
var init_document = __esm({
  "editor/src/document.mjs"() {
    init_errors();
    init_engine();
    init_history();
    init_model();
    init_ops();
    init_save();
    MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
    DocumentSession = class {
      constructor({ source, store, cliArgv, engine, index, phase, recovery, recoverySourceBytes, recoverySaveIntent, model }) {
        this.source = source;
        this.store = store;
        this.cliArgv = cliArgv;
        this.engine = engine;
        this.index = index;
        this.phase = phase;
        this.recovery = recovery;
        this.recoverySourceBytes = recoverySourceBytes;
        this.recoverySaveIntent = recoverySaveIntent;
        this.model = model;
        this.engineGeneration = 0;
        this.statusSeq = 0;
        this.renderedRevision = null;
        this.tail = Promise.resolve();
        this.engineSuspect = false;
        this.listeners = /* @__PURE__ */ new Set();
        this.statusListeners = /* @__PURE__ */ new Set();
        this.closePromise = null;
      }
      setPhase(phase) {
        if (this.phase === phase) return;
        this.phase = phase;
        this.statusSeq += 1;
        for (const listener of this.statusListeners) {
          try {
            listener(this.info());
          } catch {
          }
        }
      }
      /** @returns {{session_id:string,original_path:string,revision:number,checkpoint_id:string,
       * dirty:boolean,phase:string,status_seq:number,rendered_revision:number|null,recovery?:object}} */
      info() {
        const info = {
          session_id: this.source.session_id,
          original_path: this.source.original_path,
          revision: this.index.revision,
          checkpoint_id: currentCheckpoint(this.index),
          dirty: currentCheckpoint(this.index) !== this.index.saved_id,
          phase: this.phase,
          status_seq: this.statusSeq,
          rendered_revision: this.renderedRevision
        };
        if (this.recovery) info.recovery = { ...this.recovery };
        return info;
      }
      /** @template T @param {()=>Promise<T>} fn @returns {Promise<T>} */
      runExclusive(fn) {
        const operation = this.tail.then(fn);
        this.tail = operation.then(() => void 0, () => void 0);
        return operation;
      }
      assertExpected(sessionId, baseRevision) {
        if (sessionId !== this.source.session_id) {
          throw documentError("SESSION_MISMATCH", "Request belongs to another document session");
        }
        if (!Number.isSafeInteger(baseRevision) || baseRevision !== this.index.revision) {
          throw documentError("REVISION_CONFLICT", "Request revision is no longer current", {
            expected: this.index.revision,
            received: baseRevision
          });
        }
      }
      assertReadable() {
        if (this.phase === "blocked") throw documentError("DOCUMENT_BLOCKED", "Document cannot be restored");
        if (this.phase === "closing" || this.phase === "closed") {
          throw documentError("DOCUMENT_CLOSED", "Document session is closed");
        }
      }
      assertQueryable() {
        this.assertReadable();
        if (this.phase === "recovering") {
          throw documentError("RECOVERY_REQUIRED", "Recovery must be resolved before reading document state");
        }
      }
      assertMutable() {
        this.assertQueryable();
        if (this.phase !== "ready") throw documentError("DOCUMENT_BUSY", "Document is not ready for editing");
      }
      async notifyCommit() {
        const info = this.info();
        for (const listener of this.listeners) {
          try {
            listener(info);
          } catch {
          }
        }
      }
      async replaceEngineFromWorking() {
        this.engineGeneration += 1;
        const previous = this.engine;
        await previous?.close();
        let replacement;
        try {
          replacement = await startEngine({
            argv: this.cliArgv,
            input: this.source.working_path,
            output: this.source.working_path,
            timeout_ms: 12e4
          });
          const model = await readModel(replacement);
          this.engine = replacement;
          this.model = model;
          this.engineSuspect = false;
        } catch (error) {
          await replacement?.close();
          throw error;
        }
      }
      async restoreConfirmed(bytes) {
        this.setPhase("restoring");
        try {
          await this.source.restore(bytes);
          await this.replaceEngineFromWorking();
          this.setPhase("ready");
        } catch (error) {
          this.setPhase("blocked");
          throw error;
        }
      }
      /**
       * Apply one structured atomic batch against an expected confirmed revision.
       * @param {{session_id:string,base_revision:number,operations:unknown}} request
       * @param {(()=>boolean)|undefined} [isCurrent] Internal view-lifetime fence, checked inside the document queue.
       * @returns {Promise<{revision:number,checkpoint_id:string,created:object[],warnings:string[]}>}
       */
      applyChanges(request, isCurrent) {
        if (!request || typeof request !== "object") {
          return Promise.reject(documentError("OPERATIONS_INVALID", "Request must be an object"));
        }
        let body;
        try {
          body = compileOperations(request.operations);
        } catch (error) {
          return Promise.reject(error);
        }
        return this.runExclusive(async () => {
          this.assertMutable();
          this.assertExpected(request.session_id, request.base_revision);
          if (isCurrent && !isCurrent()) throw documentError("VIEW_STALE", "The view closed before its edits were applied");
          const previousBytes = await this.store.read(currentCheckpoint(this.index));
          if (this.engineSuspect) {
            try {
              await this.restoreConfirmed(previousBytes);
            } catch (restoreError) {
              throw documentError("DOCUMENT_BLOCKED", "The confirmed checkpoint could not be restored before editing", {
                restore: restoreError
              });
            }
          }
          if (isCurrent && !isCurrent()) throw documentError("VIEW_STALE", "The view closed before its edits were applied");
          this.setPhase("applying");
          try {
            const reply2 = await this.engine.exec(body);
            if (!reply2.value || !Array.isArray(reply2.value.created)) {
              throw documentError("ENGINE_PROTOCOL", "Engine returned invalid operation results");
            }
            this.setPhase("checkpointing");
            await this.engine.save();
            const bytes = await readFile2(this.source.working_path);
            assertDocumentSize(bytes);
            const checkpoint = await this.store.put(bytes);
            if (checkpoint.id === currentCheckpoint(this.index)) {
              this.setPhase("ready");
              return {
                revision: this.index.revision,
                checkpoint_id: checkpoint.id,
                created: reply2.value.created,
                warnings: reply2.warnings
              };
            }
            const next = appendHistory(this.index, checkpoint);
            this.index = await this.store.publish(next);
            this.setPhase("ready");
            const result = {
              revision: this.index.revision,
              checkpoint_id: currentCheckpoint(this.index),
              created: reply2.value.created,
              warnings: reply2.warnings
            };
            await this.notifyCommit();
            return result;
          } catch (error) {
            try {
              await this.restoreConfirmed(previousBytes);
            } catch (restoreError) {
              throw documentError("DOCUMENT_BLOCKED", "The last confirmed checkpoint could not be restored", {
                cause: error,
                restore: restoreError
              });
            }
            if (error?.code === "ENGINE_REJECTED") throw documentError("OPERATIONS_REJECTED", refusalReason(error));
            throw error;
          }
        });
      }
      /** @param {'undo'|'redo'} direction @param {{session_id:string,base_revision:number}} request */
      moveHistory(direction, request) {
        return this.runExclusive(async () => {
          this.assertMutable();
          this.assertExpected(request?.session_id, request?.base_revision);
          const target = seekHistory(this.index, direction);
          if (target.cursor === this.index.cursor) {
            throw documentError("HISTORY_UNAVAILABLE", `No ${direction} checkpoint is available`);
          }
          const previousBytes = await this.store.read(currentCheckpoint(this.index));
          const targetBytes = await this.store.read(currentCheckpoint(target));
          this.setPhase("restoring");
          try {
            await this.source.restore(targetBytes);
            await this.replaceEngineFromWorking();
            const next = { ...target, revision: this.index.revision + 1 };
            this.index = await this.store.publish(next);
            this.setPhase("ready");
            await this.notifyCommit();
            return { revision: this.index.revision, checkpoint_id: currentCheckpoint(this.index) };
          } catch (error) {
            try {
              await this.restoreConfirmed(previousBytes);
            } catch (restoreError) {
              throw documentError("DOCUMENT_BLOCKED", "The last confirmed checkpoint could not be restored", {
                cause: error,
                restore: restoreError
              });
            }
            throw error;
          }
        });
      }
      /** @param {{session_id:string,base_revision:number}} request */
      undo(request) {
        return this.moveHistory("undo", request);
      }
      /** @param {{session_id:string,base_revision:number}} request */
      redo(request) {
        return this.moveHistory("redo", request);
      }
      /**
       * Drops every change made since the last save, so that closing leaves no recovery behind. The history keeps only the
       * saved checkpoint; the engine is rebuilt from it before the next edit.
       * @param {{session_id:string,base_revision:number}} request
       * @returns {Promise<{discarded:boolean,revision:number}>}
       */
      discardUnsaved(request) {
        return this.runExclusive(async () => {
          this.assertMutable();
          this.assertExpected(request?.session_id, request?.base_revision);
          const saved = this.index.saved_id;
          if (currentCheckpoint(this.index) === saved) return { discarded: false, revision: this.index.revision };
          this.index = await this.store.publish({
            ...this.index,
            snapshots: [saved],
            cursor: 0,
            revision: this.index.revision + 1,
            sizes: { [saved]: this.index.sizes[saved] }
          });
          this.engineSuspect = true;
          await this.notifyCommit();
          return { discarded: true, revision: this.index.revision };
        });
      }
      /** @param {'recover'|'discard'|'copy'} choice */
      resolveRecovery(choice) {
        return this.runExclusive(async () => {
          if (choice !== "recover" && choice !== "discard" && choice !== "copy") {
            throw documentError("RECOVERY_CHOICE_INVALID", "Recovery choice is not supported");
          }
          this.assertReadable();
          if (this.phase !== "recovering" || !this.recovery) {
            throw documentError("RECOVERY_NOT_REQUIRED", "This document has no pending recovery");
          }
          if (this.recovery.save_conflict && choice !== "copy") {
            throw documentError("RECOVERY_CHOICE_INVALID", "Save conflict requires a recovery copy", {
              valid_choices: ["copy"]
            });
          }
          if (choice === "copy" && this.recovery.source_matches !== false && !this.recovery.save_conflict) {
            throw documentError("RECOVERY_CHOICE_INVALID", "A recovery copy is only available for an external conflict");
          }
          const confirmedBytes = await this.store.read(currentCheckpoint(this.index));
          if (choice !== "copy") await this.source.assertDiskBase();
          let recoveryCopy;
          if (choice === "copy") {
            recoveryCopy = await createRecoveryCopy({
              bytes: confirmedBytes,
              original: this.source.original_path,
              checkpoint_id: currentCheckpoint(this.index)
            });
          }
          if (choice === "recover" || choice === "copy") {
            try {
              this.setPhase("restoring");
              await this.source.restore(confirmedBytes);
              await this.replaceEngineFromWorking();
              let candidate;
              let leftovers = [];
              const externalBackup = choice === "copy" && this.recoverySaveIntent ? this.recoverySaveIntent.backup_path : void 0;
              if (this.recoverySaveIntent && choice === "copy") {
                await removeSaveIntent(this.store.dir);
                const cleanup = await removeCandidate(this.recoverySaveIntent);
                leftovers = cleanup.leftovers;
                if (leftovers.includes(this.recoverySaveIntent.candidate_path)) {
                  candidate = this.recoverySaveIntent.candidate_path;
                }
                this.recoverySaveIntent = void 0;
              }
              this.recovery = void 0;
              this.recoverySourceBytes = void 0;
              this.setPhase("ready");
              return {
                ...this.info(),
                ...recoveryCopy ? { recovery_copy: recoveryCopy.path } : {},
                ...externalBackup ? { external_backup: externalBackup } : {},
                ...candidate ? { candidate } : {},
                ...leftovers.length ? { leftovers } : {}
              };
            } catch (error) {
              this.setPhase("blocked");
              throw error;
            }
          }
          const sourceBytes = this.recoverySourceBytes;
          assertDocumentSize(sourceBytes);
          const checkpoint = await this.store.put(sourceBytes);
          const next = {
            ...this.index,
            source: { fingerprint: this.source.source_fingerprint },
            snapshots: [checkpoint.id],
            cursor: 0,
            revision: this.index.revision + 1,
            sizes: { ...this.index.sizes, [checkpoint.id]: checkpoint.bytes }
          };
          try {
            this.setPhase("restoring");
            await this.source.restore(sourceBytes);
            await this.replaceEngineFromWorking();
            this.index = await this.store.publish(next);
            this.recovery = void 0;
            this.recoverySourceBytes = void 0;
            this.setPhase("ready");
            await this.notifyCommit();
            return this.info();
          } catch (error) {
            try {
              await this.source.restore(confirmedBytes);
              await this.replaceEngineFromWorking();
              this.setPhase("recovering");
            } catch (restoreError) {
              this.setPhase("blocked");
              throw documentError("DOCUMENT_BLOCKED", "The recovered checkpoint could not be restored", {
                cause: error,
                restore: restoreError
              });
            }
            throw error;
          }
        });
      }
      /**
       * Serialize query/export access against one confirmed revision. The callback receives a
       * temporary facade. Verification compares the final serialized engine state to the current checkpoint.
       * Exec mutations reverted to identical bytes are equivalent; nonserialized engine state is outside the document contract.
       * @template T
       * @param {number} expectedRevision
       * @param {(engine:Readonly<{exec:(body:string,options?:{kind:'mutate'|'read'|'measure'})=>Promise<{value:any,warnings:string[]}>,
       * schema:()=>Promise<string>}>)=>Promise<T>} fn
       * @returns {Promise<T>}
       */
      withEngine(expectedRevision, fn) {
        if (typeof fn !== "function") {
          return Promise.reject(documentError("DOCUMENT_CALLBACK_INVALID", "Engine callback must be a function"));
        }
        return this.runExclusive(async () => {
          this.assertQueryable();
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.index.revision) {
            throw documentError("REVISION_CONFLICT", "Requested engine revision is no longer current");
          }
          const access2 = createEngineFacade(this.engine);
          try {
            return await fn(access2.facade);
          } finally {
            await access2.expire();
            if (access2.didExec()) {
              try {
                await this.engine.save();
                const [workingBytes, checkpointBytes] = await Promise.all([
                  readFile2(this.source.working_path),
                  this.store.read(currentCheckpoint(this.index))
                ]);
                this.engineSuspect = !workingBytes.equals(checkpointBytes);
              } catch {
                this.engineSuspect = true;
              }
            }
          }
        });
      }
      /** @param {string} path @returns {Promise<any|null>} */
      readNode(path) {
        return this.runExclusive(async () => {
          this.assertQueryable();
          return readNode(this.engine, path);
        });
      }
      /** @returns {Promise<{roots:any[],rows:any[],variables:object}>} */
      readModel() {
        return this.runExclusive(async () => {
          this.assertQueryable();
          return readModel(this.engine);
        });
      }
      /** @param {(info:ReturnType<DocumentSession['info']>)=>void} fn @returns {()=>void} */
      onCommit(fn) {
        if (typeof fn !== "function") throw documentError("DOCUMENT_CALLBACK_INVALID", "Commit listener must be a function");
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      }
      /** Observe accepted work without waiting for an engine read or a durable commit. */
      onStatus(fn) {
        if (typeof fn !== "function") throw documentError("DOCUMENT_CALLBACK_INVALID", "Status listener must be a function");
        this.statusListeners.add(fn);
        return () => this.statusListeners.delete(fn);
      }
      /** @returns {Promise<void>} */
      close() {
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.runExclusive(async () => {
          if (this.phase === "closed") return;
          this.setPhase("closing");
          try {
            await this.engine?.close();
            await this.source.discardWorking();
          } finally {
            await this.source.release();
            this.setPhase("closed");
          }
        });
        return this.closePromise;
      }
      /**
       * Publish only the current confirmed checkpoint to the original file.
       * @param {{session_id:string,base_revision:number}} request
       */
      saveOriginal(request) {
        return this.runExclusive(async () => {
          this.assertMutable();
          assertSaveRequest(request);
          this.assertExpected(request.session_id, request.base_revision);
          const checkpointId = currentCheckpoint(this.index);
          if (checkpointId === this.index.saved_id) {
            return { saved: false, checkpoint_id: checkpointId };
          }
          const checkpoint = await this.store.read(checkpointId);
          assertDocumentSize(checkpoint);
          let intent;
          try {
            intent = await prepareSave({
              bytes: checkpoint,
              original: this.source.original_path,
              session_id: this.source.session_id,
              expected_hash: this.source.source_fingerprint,
              checkpoint_id: checkpointId
            });
            await this.source.assertDiskBase();
            await writeSaveIntent(this.store.dir, intent);
          } catch (error) {
            if (intent) {
              try {
                const cleanup = await removeCandidate(intent);
                if (cleanup.leftovers.length) {
                  error.details = { ...error.details ?? {}, leftovers: cleanup.leftovers };
                }
              } catch (cleanupError) {
                error.details = { ...error.details ?? {}, cleanup_error: cleanupError };
              }
            }
            throw error;
          }
          this.setPhase("saving");
          let finalPhase = "ready";
          try {
            let outcome;
            try {
              outcome = await publishWindows({
                candidate: intent.candidate_path,
                original: intent.original_path,
                backup: intent.backup_path,
                expected_hash: intent.expected_hash
              });
            } catch (error) {
              finalPhase = "blocked";
              let preservationError;
              try {
                const preserved = await preserveCandidate(intent, checkpoint);
                intent = preserved.intent;
                await writeSaveIntent(this.store.dir, { ...intent, uncertain: true }, { replace: true });
              } catch (failure) {
                preservationError = failure;
              }
              throw documentError("SAVE_UNCERTAIN", "Save helper failed without a confirmed outcome", {
                cause: error,
                ...preservationError ? { preservation_error: preservationError } : {}
              });
            }
            if (outcome.published === false) {
              const cleanup2 = await Promise.allSettled([
                removeSaveIntent(this.store.dir),
                removeCandidate(intent)
              ]);
              const candidateCleanup = cleanup2[1].status === "fulfilled" ? cleanup2[1].value : { leftovers: [] };
              const code = typeof outcome.error?.code === "string" ? outcome.error.code : "SAVE_FAILED";
              throw documentError(code, "The original was not published", {
                outcome,
                leftovers: [...outcome.leftovers ?? [], ...candidateCleanup.leftovers],
                cleanup_errors: cleanup2.filter((result) => result.status === "rejected").map((result) => result.reason)
              });
            }
            if (outcome.published === null) {
              finalPhase = "blocked";
              const indexBefore = this.index;
              let reconciliation;
              let reconciliationError;
              try {
                try {
                  await this.source.acceptPublished(intent.candidate_hash);
                } catch (candidateError) {
                  try {
                    await this.source.assertDiskBase();
                  } catch (baseError) {
                    throw documentError("SAVE_UNCERTAIN", "Neither the candidate nor the previous source hash matches", {
                      candidate_error: candidateError,
                      base_error: baseError
                    });
                  }
                }
                reconciliation = await reconcileSaveIntent({
                  source: this.source,
                  store: this.store,
                  index: indexBefore
                });
              } catch (error) {
                reconciliationError = error;
              }
              if (reconciliation && !reconciliation.recovery) {
                this.index = reconciliation.index;
                finalPhase = "ready";
                const leftovers2 = [
                  ...outcome.leftovers ?? [],
                  ...reconciliation.leftovers ?? []
                ];
                if (this.index.saved_id !== indexBefore.saved_id) {
                  return {
                    saved: true,
                    revision: this.index.revision,
                    checkpoint_id: this.index.saved_id,
                    backup_path: this.index.save_backup?.path,
                    recognized: true,
                    ...leftovers2.length ? { leftovers: [...new Set(leftovers2)] } : {}
                  };
                }
                throw documentError("SAVE_UNCERTAIN", "The Save was not performed; the original is intact and may be retried", {
                  outcome,
                  published: false,
                  original_intact: true,
                  retryable: true,
                  leftovers: [...new Set(leftovers2)]
                });
              }
              if (reconciliation?.recovery) {
                throw documentError("SAVE_UNCERTAIN", "The publication result requires explicit recovery", {
                  outcome,
                  recovery: reconciliation.recovery
                });
              }
              let preservationError;
              try {
                const preserved = await preserveCandidate(intent, checkpoint);
                intent = preserved.intent;
                await writeSaveIntent(this.store.dir, { ...intent, uncertain: true }, { replace: true });
              } catch (error) {
                preservationError = error;
              }
              throw documentError("SAVE_UNCERTAIN", "The publication result is uncertain", {
                outcome,
                ...reconciliationError ? { reconciliation_error: reconciliationError } : {},
                ...preservationError ? { preservation_error: preservationError } : {}
              });
            }
            let preserveResult;
            try {
              preserveResult = await preserveCandidate({
                ...intent,
                backup_identity: outcome.backup_identity
              }, checkpoint);
              intent = {
                ...preserveResult.intent,
                published: true,
                source_hash: outcome.source_hash,
                replaced_hash: outcome.replaced_hash,
                conflict: outcome.conflict === true
              };
              await writeSaveIntent(this.store.dir, intent, { replace: true });
            } catch (error) {
              finalPhase = "blocked";
              throw documentError("SAVE_UNCERTAIN", "Published bytes could not be recorded safely", { cause: error });
            }
            if (intent.conflict || outcome.source_hash !== checkpointId || outcome.replaced_hash !== intent.expected_hash) {
              finalPhase = "blocked";
              throw documentError("SAVE_CONFLICT", "Another writer changed the original during publication", { outcome });
            }
            const previousIndex = this.index;
            let publishedIndex;
            try {
              publishedIndex = await this.store.publish({
                ...this.index,
                saved_id: checkpointId,
                source: { fingerprint: outcome.source_hash },
                save_backup: {
                  path: intent.backup_path,
                  owner_session_id: this.source.session_id,
                  identity: intent.backup_identity
                }
              });
            } catch (error) {
              finalPhase = "blocked";
              throw documentError("SAVE_UNCERTAIN", "The original was published but the Save index was not confirmed", {
                cause: error,
                source_hash: outcome.source_hash
              });
            }
            try {
              await this.source.acceptPublished(outcome.source_hash);
            } catch (error) {
              finalPhase = "blocked";
              throw documentError("SAVE_UNCERTAIN", "The published original changed before confirmation", { cause: error });
            }
            this.index = publishedIndex;
            const cleanup = await Promise.allSettled([
              removeSaveIntent(this.store.dir),
              removeCandidate(intent),
              removePreviousBackup(
                previousIndex,
                this.source.session_id,
                intent.backup_path,
                this.source.original_path
              )
            ]);
            const cleanupError = cleanup.find((result) => result.status === "rejected");
            if (cleanupError?.status === "rejected") throw cleanupError.reason;
            const leftovers = [
              ...outcome.leftovers ?? [],
              ...preserveResult.leftovers,
              ...cleanup[1].value.leftovers,
              ...cleanup[2].value.leftovers
            ];
            return {
              saved: true,
              revision: this.index.revision,
              checkpoint_id: checkpointId,
              backup_path: intent.backup_path,
              ...leftovers.length ? { leftovers: [...new Set(leftovers)] } : {}
            };
          } finally {
            this.setPhase(finalPhase);
          }
        });
      }
      /** @param {{session_id:string,base_revision:number}} request */
      saveRecoveryCopy(request) {
        return this.runExclusive(async () => {
          this.assertReadable();
          this.assertExpected(request?.session_id, request?.base_revision);
          if (this.phase !== "ready" && this.phase !== "recovering") {
            throw documentError("DOCUMENT_BUSY", "Document is not ready to create a recovery copy");
          }
          const checkpointId = currentCheckpoint(this.index);
          const bytes = await this.store.read(checkpointId);
          assertDocumentSize(bytes);
          return createRecoveryCopy({
            bytes,
            original: this.source.original_path,
            checkpoint_id: checkpointId
          });
        });
      }
    };
  }
});

// editor/src/draft.mjs
function newTextDraft({ session_id, base_revision, path, property, value }) {
  return {
    session_id,
    base_revision,
    path,
    property,
    text: value,
    original: value,
    cursor: 0,
    history: [],
    conflict: false
  };
}
function isValidUtf16Index(text, index) {
  if (index < 0 || index > text.length) return false;
  if (index === 0 || index === text.length) return true;
  const code = text.charCodeAt(index);
  return !(code >= 56320 && code <= 57343);
}
function clampCursor(cursor, text) {
  if (!Number.isFinite(cursor)) return 0;
  return Math.min(Math.max(Math.trunc(cursor), 0), text.length);
}
function validateRange(draft, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new EditorError("DRAFT_RANGE", "from and to must be integers");
  }
  if (from < 0 || to > draft.text.length || from > to) {
    throw new EditorError("DRAFT_RANGE", `invalid range: ${from} to ${to} for text of length ${draft.text.length}`);
  }
  if (!isValidUtf16Index(draft.text, from) || !isValidUtf16Index(draft.text, to)) {
    throw new EditorError("DRAFT_RANGE", "range cannot split UTF-16 surrogate pair");
  }
}
function editDraft(draft, { from, to, len, text, cursor }) {
  if (len !== draft.text.length) {
    return {
      ...draft,
      cursor: clampCursor(draft.cursor, draft.text),
      conflict: true
    };
  }
  validateRange(draft, from, to);
  if (text === "" && from === to) {
    return { ...draft, cursor: clampCursor(cursor, draft.text) };
  }
  const before = draft.text.slice(0, from);
  const after = draft.text.slice(to);
  const newText = before + text + after;
  const newHistory = [
    ...draft.history,
    { text: draft.text, cursor: clampCursor(draft.cursor, draft.text) }
  ];
  return {
    ...draft,
    text: newText,
    cursor: clampCursor(cursor, newText),
    history: newHistory,
    conflict: draft.conflict
  };
}
function undoDraft(draft) {
  if (draft.history.length === 0) {
    return draft;
  }
  const lastEntry = draft.history[draft.history.length - 1];
  const previousText = typeof lastEntry === "string" ? lastEntry : lastEntry.text;
  const previousCursor = typeof lastEntry === "object" ? lastEntry.cursor : draft.cursor;
  const newHistory = draft.history.slice(0, -1);
  return {
    ...draft,
    text: previousText,
    cursor: clampCursor(previousCursor, previousText),
    history: newHistory,
    conflict: draft.conflict
  };
}
function keyEdit(draft, key, { multiline = false } = {}) {
  const text = draft.text;
  const at = clampCursor(draft.cursor, text);
  const edit = (from, to, insert, cursor) => ({ from, to, len: text.length, text: insert, cursor });
  const back = at >= 2 && isHigh(text.charCodeAt(at - 2)) && isLow(text.charCodeAt(at - 1)) ? 2 : 1;
  const forward = isHigh(text.charCodeAt(at)) && isLow(text.charCodeAt(at + 1)) ? 2 : 1;
  if (!key.ctrl && !key.alt && !key.meta) {
    switch (key.name) {
      case "backspace":
        return at > 0 ? edit(at - back, at, "", at - back) : null;
      case "delete":
        return at < text.length ? edit(at, at + forward, "", at) : null;
      case "left":
        return at > 0 ? edit(at - back, at - back, "", at - back) : null;
      case "right":
        return at < text.length ? edit(at + forward, at + forward, "", at + forward) : null;
      case "enter":
        return multiline ? edit(at, at, "\n", at + 1) : null;
    }
  }
  if (key.ctrl && !key.alt || key.meta || typeof key.text !== "string") return null;
  let inserted = key.text.replace(/\r\n?/g, "\n");
  if (!multiline) inserted = inserted.replaceAll("\n", " ");
  if (inserted === "" || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(inserted)) return null;
  return edit(at, at, inserted, at + inserted.length);
}
function draftOperation(draft, currentRevision2) {
  if (currentRevision2 !== draft.base_revision) {
    throw new EditorError(
      "DRAFT_STALE",
      `Draft base revision ${draft.base_revision} does not match current revision ${currentRevision2}`
    );
  }
  if (draft.conflict) {
    throw new EditorError("DRAFT_CONFLICT", "Draft has a pending text conflict");
  }
  if (draft.text === draft.original) {
    return null;
  }
  return {
    op: "update",
    path: draft.path,
    props: {
      [draft.property]: draft.text
    }
  };
}
var isHigh, isLow;
var init_draft = __esm({
  "editor/src/draft.mjs"() {
    init_errors();
    isHigh = (code) => code >= 55296 && code <= 56319;
    isLow = (code) => code >= 56320 && code <= 57343;
  }
});

// editor/src/protocol.mjs
import { createHash as createHash2, timingSafeEqual } from "node:crypto";
import { join as join3 } from "node:path";
function protocolError(code, message) {
  throw new EditorError(code, message);
}
function object(value, name = "value") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    protocolError("INVALID_REQUEST", `${name} must be an object`);
  }
}
function string(value, name) {
  if (typeof value !== "string" || value.length === 0) protocolError("INVALID_REQUEST", `${name} must be a nonempty string`);
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) protocolError("INVALID_REQUEST", `${name} must be a nonnegative safe integer`);
}
function inspect(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") protocolError("INVALID_REQUEST", "Request must contain only JSON values");
  if (seen.has(value)) protocolError("INVALID_REQUEST", "Request must not be cyclic");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) inspect(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_FIELDS.has(key)) protocolError("FORBIDDEN_FIELD", "Request contains a forbidden field");
      inspect(item, seen);
    }
  }
  seen.delete(value);
}
function expected(args) {
  string(args.session_id, "session_id");
  integer(args.base_revision, "base_revision");
}
function viewTag(args) {
  string(args.request_id, "request_id");
  string(args.view_id, "view_id");
  integer(args.view_generation, "view_generation");
  if (Object.hasOwn(args, "scene_revision")) integer(args.scene_revision, "scene_revision");
}
function validateCall(method, args, requestBytes = 0) {
  if (!METHODS.includes(method)) protocolError("METHOD_NOT_FOUND", "Method is not supported");
  if (!Number.isSafeInteger(requestBytes) || requestBytes < 0 || requestBytes > MAX_REQUEST_BYTES) {
    protocolError("LIMIT_EXCEEDED", "Request exceeds 1 MiB");
  }
  object(args, "args");
  inspect(args);
  const allowed = new Set(METHOD_KEYS[method]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) protocolError("INVALID_REQUEST", `${method} contains an unsupported field`);
  }
  for (const key of REQUIRED_KEYS[method] ?? []) {
    if (!Object.hasOwn(args, key)) protocolError("INVALID_REQUEST", `${method} requires ${key}`);
  }
  if (EXPECTED_KEYS.has("session_id") && Object.hasOwn(args, "session_id")) expected(args);
  switch (method) {
    case "get_nodes":
      if (!Array.isArray(args.paths) || args.paths.length > MAX_METADATA_NODES) protocolError("LIMIT_EXCEEDED", "Node query exceeds 64 paths");
      for (const path of args.paths) string(path, "path");
      break;
    case "resolve_recovery":
      string(args.choice, "choice");
      break;
    case "apply_changes":
      if (!Array.isArray(args.operations)) protocolError("INVALID_REQUEST", "operations must be an array");
      if (args.operations.length > MAX_OPERATIONS2) protocolError("LIMIT_EXCEEDED", "Batch exceeds 100 operations");
      if (Buffer.byteLength(JSON.stringify(args.operations), "utf8") > MAX_REQUEST_BYTES) {
        protocolError("LIMIT_EXCEEDED", "Batch exceeds 1 MiB");
      }
      break;
    case "get_frame_image":
      string(args.frame_id, "frame_id");
      if (Object.hasOwn(args, "max_side") && (!Number.isFinite(args.max_side) || args.max_side <= 0)) {
        protocolError("INVALID_REQUEST", "max_side must be positive");
      }
      break;
    case "attach_view":
    case "detach_view":
    case "poll_view":
    case "list_frames":
    case "select_node":
    case "submit_capture":
      viewTag(args);
      if (method === "submit_capture") string(args.capture_id, "capture_id");
      if (Object.hasOwn(args, "frame_id")) string(args.frame_id, "frame_id");
      if (Object.hasOwn(args, "holder")) string(args.holder, "holder");
      if (Object.hasOwn(args, "cursor") && args.cursor !== null) integer(args.cursor, "cursor");
      if (Object.hasOwn(args, "since")) integer(args.since, "since");
      if (Object.hasOwn(args, "wait_ms")) integer(args.wait_ms, "wait_ms");
      if (Object.hasOwn(args, "path")) string(args.path, "path");
      if (Object.hasOwn(args, "changes") && !Array.isArray(args.changes)) protocolError("INVALID_REQUEST", "changes must be an array");
      if (Object.hasOwn(args, "texts") && !Array.isArray(args.texts)) protocolError("INVALID_REQUEST", "texts must be an array");
      if (Object.hasOwn(args, "needs_reconcile") && typeof args.needs_reconcile !== "boolean") protocolError("INVALID_REQUEST", "needs_reconcile must be a boolean");
      if (Object.hasOwn(args, "direct") && typeof args.direct !== "boolean") protocolError("INVALID_REQUEST", "direct must be a boolean");
      break;
  }
  return args;
}
function validateMetadataPage(page) {
  object(page, "page");
  if (!Array.isArray(page.nodes)) protocolError("INVALID_REQUEST", "page.nodes must be an array");
  if (page.nodes.length > MAX_METADATA_NODES || Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_METADATA_BYTES) {
    protocolError("LIMIT_EXCEEDED", "Metadata page exceeds its limit");
  }
  return true;
}
function authorize(header, token, active = true) {
  const prefix = "Bearer ";
  const supplied = typeof header === "string" && header.startsWith(prefix) ? header.slice(prefix.length) : "";
  const left = createHash2("sha256").update(supplied).digest();
  const right = createHash2("sha256").update(token).digest();
  const equal = timingSafeEqual(left, right);
  if (!active || !equal) protocolError("UNAUTHORIZED", "Authorization failed");
  return true;
}
function publicError(error, _token = "") {
  let code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
  if (code === "REVISION_CONFLICT") code = "REVISION_STALE";
  if (["RENDER_CLOSED", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code)) code = "SESSION_UNAVAILABLE";
  if (!Object.hasOwn(PUBLIC_MESSAGES, code)) code = "INTERNAL_ERROR";
  return { code, message: code === "OPERATIONS_REJECTED" && error.message ? error.message : PUBLIC_MESSAGES[code] };
}
function sessionRecordPath(dataDir, canonicalOriginal) {
  const hash = createHash2("sha256").update(canonicalOriginal).digest("hex");
  return join3(dataDir, "sessions", `${hash}.json`);
}
function activityState(info, render) {
  if (["closing", "closed"].includes(info.phase)) return "disconnected";
  if (info.phase === "blocked" || render.error) return "error";
  if (["opening", "recovering"].includes(info.phase) || render.rendered_revision === null) return "loading";
  if (["applying", "checkpointing", "restoring"].includes(info.phase)) return "working";
  if (info.phase === "saving") return "saving";
  return render.rendered_revision < info.revision ? "working" : "ready";
}
var MAX_OPERATIONS2, MAX_REQUEST_BYTES, MAX_METADATA_NODES, MAX_METADATA_BYTES, MCP_METHODS, VIEW_METHODS, METHODS, FORBIDDEN_FIELDS, EXPECTED_KEYS, METHOD_KEYS, REQUIRED_KEYS, PUBLIC_MESSAGES;
var init_protocol = __esm({
  "editor/src/protocol.mjs"() {
    init_errors();
    MAX_OPERATIONS2 = 100;
    MAX_REQUEST_BYTES = 1024 * 1024;
    MAX_METADATA_NODES = 64;
    MAX_METADATA_BYTES = 32 * 1024;
    MCP_METHODS = Object.freeze([
      "get_document",
      "get_nodes",
      "get_variables",
      "get_schema",
      "apply_changes",
      "get_frame_image",
      "undo_document",
      "redo_document",
      "save_document",
      "save_recovery_copy"
    ]);
    VIEW_METHODS = Object.freeze(["attach_view", "detach_view", "poll_view", "list_frames", "select_node", "submit_capture", "discard_unsaved", "resolve_recovery", "get_mcp_config", "close_editor", "poll_document"]);
    METHODS = Object.freeze([...MCP_METHODS, ...VIEW_METHODS]);
    FORBIDDEN_FIELDS = /* @__PURE__ */ new Set(["filePath", "original_path", "shell", "input", "script", "code"]);
    EXPECTED_KEYS = /* @__PURE__ */ new Set(["session_id", "base_revision"]);
    METHOD_KEYS = {
      get_document: [],
      get_nodes: ["paths"],
      get_variables: [],
      get_schema: [],
      apply_changes: ["session_id", "base_revision", "operations"],
      get_frame_image: ["frame_id", "max_side"],
      undo_document: [...EXPECTED_KEYS],
      redo_document: [...EXPECTED_KEYS],
      save_document: [...EXPECTED_KEYS],
      save_recovery_copy: [...EXPECTED_KEYS],
      discard_unsaved: [...EXPECTED_KEYS],
      get_mcp_config: [],
      close_editor: [],
      poll_document: [],
      resolve_recovery: ["choice"],
      attach_view: ["request_id", "view_id", "view_generation", "scene_revision", "frame_id", "holder"],
      detach_view: ["request_id", "view_id", "view_generation"],
      poll_view: ["request_id", "view_id", "view_generation", "frame_id", "cursor"],
      list_frames: ["request_id", "view_id", "view_generation", "cursor", "since", "wait_ms"],
      select_node: ["request_id", "view_id", "view_generation", "scene_revision", "path"],
      submit_capture: ["request_id", "capture_id", "view_id", "view_generation", "scene_revision", "changes", "needs_reconcile", "direct", "texts"]
    };
    REQUIRED_KEYS = {
      get_nodes: ["paths"],
      apply_changes: ["session_id", "base_revision", "operations"],
      get_frame_image: ["frame_id"],
      undo_document: [...EXPECTED_KEYS],
      redo_document: [...EXPECTED_KEYS],
      save_document: [...EXPECTED_KEYS],
      discard_unsaved: [...EXPECTED_KEYS],
      resolve_recovery: ["choice"],
      save_recovery_copy: [...EXPECTED_KEYS],
      attach_view: ["request_id", "view_id", "view_generation", "scene_revision"],
      detach_view: ["request_id", "view_id", "view_generation"],
      poll_view: ["request_id", "view_id", "view_generation"],
      list_frames: ["request_id", "view_id", "view_generation"],
      select_node: ["request_id", "view_id", "view_generation", "scene_revision", "path"],
      submit_capture: ["request_id", "capture_id", "view_id", "view_generation", "scene_revision", "changes"]
    };
    PUBLIC_MESSAGES = {
      CLIENT_CLOSED: "Session client is closed",
      DOCUMENT_BLOCKED: "Document session is blocked",
      DOCUMENT_BUSY: "Document session is busy",
      DOCUMENT_CLOSED: "Document session is closed",
      FORBIDDEN_FIELD: "Request contains a forbidden field",
      GEOMETRY_AMBIGUOUS: "Target geometry is ambiguous",
      GEOMETRY_CAPTURE_STALE: "Geometry capture is stale",
      GEOMETRY_CONTROLLED_BY_LAYOUT: "Target geometry is controlled by layout",
      GEOMETRY_INVALID: "Geometry request is invalid",
      GEOMETRY_NOT_TEXT: "Target is not a plain text node",
      GEOMETRY_TEXT_CONFLICT: "The text of the node changed meanwhile",
      GEOMETRY_SIZE_AMBIGUOUS: "Target size is ambiguous",
      GEOMETRY_TOO_MANY: "Too many board changes to apply at once",
      GEOMETRY_TARGET_MISSING: "Geometry target is missing",
      HISTORY_UNAVAILABLE: "Document history step is unavailable",
      HOST_FORBIDDEN: "Host is forbidden",
      INTERNAL_ERROR: "Internal error",
      INVALID_REQUEST: "Request is invalid",
      LIMIT_EXCEEDED: "Request exceeds a protocol limit",
      METHOD_NOT_ALLOWED: "HTTP method is not allowed",
      METHOD_NOT_FOUND: "Method is not supported",
      OPERATIONS_INVALID: "Operations are invalid",
      OPERATIONS_REJECTED: "The engine refused the operations",
      OPERATIONS_LIMIT: "Operations exceed a protocol limit",
      ORIGIN_FORBIDDEN: "Browser-originated requests are forbidden",
      RECOVERY_CHOICE_INVALID: "Recovery choice is invalid",
      RECOVERY_NOT_REQUIRED: "Document recovery is not required",
      RECOVERY_REQUIRED: "Document recovery is required",
      RENDER_FRAME_MISSING: "Requested frame is unavailable",
      RENDER_MISSING: "Rendered image is unavailable",
      RENDER_NOT_CURRENT: "Rendered image is not current",
      RENDER_SCALE_INVALID: "Requested render scale is invalid",
      REVISION_STALE: "Request revision is no longer current",
      SAVE_CONFLICT: "Save conflicts with an external change",
      SAVE_UNCERTAIN: "Save result is uncertain",
      SESSION_MISMATCH: "Request belongs to another document session",
      SESSION_UNAVAILABLE: "Document session is unavailable",
      SOURCE_CHANGED: "Original document changed externally",
      UNAUTHORIZED: "Authorization failed",
      VIEW_STALE: "View generation is no longer current",
      VIEW_TAKEN: "Another window is showing this document"
    };
  }
});

// editor/src/panel-model.mjs
function readOnly(field, reason) {
  return { ...field, editable: false, value: "", reason };
}
function schemaIndex(roots) {
  const index = /* @__PURE__ */ new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.id === "string") index.set(node.id, index.has(node.id) ? null : node);
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return index;
}
function variableName(value, variables, mustExist) {
  const match = typeof value === "string" ? /^\$(\S+)$/.exec(value) : null;
  return match && (!mustExist || Object.hasOwn(variables, match[1])) ? match[1] : null;
}
function instanceOf(path, index) {
  const segments = path.split("/");
  for (let length = 1; length < segments.length; length += 1) {
    const candidate = index.get(segments.slice(0, length).join("/"));
    if (candidate?.type === "ref") return { instance: candidate, rest: segments.slice(length).join("/") };
  }
  return null;
}
function describeFields({ path, schema, row, parentRow }, model) {
  const index = schemaIndex(model.roots);
  const variables = model.variables?.variables ?? model.variables ?? {};
  if (!schema || typeof schema !== "object") {
    return FIELDS.map((field) => readOnly(field, "Node data is unavailable"));
  }
  const owner = path.includes("/") ? instanceOf(path, index) : null;
  const inInstance = path.includes("/");
  return FIELDS.map((field) => {
    const { property } = field;
    const raw = schema[property];
    if (inInstance) {
      if (!owner) return readOnly(field, "Part of a component instance");
      if (!Object.hasOwn(owner.instance.descendants?.[owner.rest] ?? {}, property)) {
        return readOnly(field, "Inherited from the component; editing would add an override");
      }
    }
    if (schema.type === "ref" && property !== "x" && property !== "y") {
      return readOnly(field, "Inherited from the component instance");
    }
    const bound = variableName(raw, variables, property === "content");
    if (property === "content") {
      if (schema.type !== "text") return readOnly(field, "Only text nodes have text");
      if (bound) return readOnly(field, `Bound to variable $${bound}`);
      if (raw !== void 0 && typeof raw !== "string") return readOnly(field, "Text is not a plain string");
      return { ...field, editable: true, value: raw ?? "" };
    }
    if (property === "x" || property === "y") {
      if (placedByLayout(parentRow, row ?? {})) {
        return readOnly(field, `Position is controlled by the parent's ${layoutOf(parentRow)} auto-layout`);
      }
      if (bound) return readOnly(field, `Bound to variable $${bound}`);
      if (typeof raw === "string") return readOnly(field, "Position is not a plain number");
      const value = raw ?? row?.[property];
      return typeof value === "number" ? { ...field, editable: true, value: String(value) } : readOnly(field, "Position is unavailable");
    }
    if (property === "width" || property === "height") {
      if (typeof raw === "number") return { ...field, editable: true, value: String(raw) };
      if (bound) return readOnly(field, `Bound to variable $${bound}`);
      if (typeof raw === "string") return readOnly(field, `Automatic size (${raw})`);
      return readOnly(field, "Automatic size (fits its content)");
    }
    if (bound) return readOnly(field, `Bound to variable $${bound}`);
    if (raw === void 0) return { ...field, editable: true, value: "" };
    if (typeof raw === "string") {
      return COLOR.test(raw) ? { ...field, editable: true, value: raw } : readOnly(field, "Not a solid color");
    }
    return readOnly(field, Array.isArray(raw) ? "Multiple fills, not a solid color" : `Fill is a ${raw?.type ?? "complex value"}, not a solid color`);
  });
}
function coerceValue(property, text) {
  if (property === "content") return { ok: true, value: text };
  const trimmed = text.trim();
  if (property === "fill") {
    return COLOR.test(trimmed) ? { ok: true, value: trimmed } : { ok: false, error: "Enter a color such as #RRGGBB or #RRGGBBAA" };
  }
  if (!NUMBER.test(trimmed)) return { ok: false, error: "Enter a number" };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, error: "Enter a finite number" };
  if ((property === "width" || property === "height") && value < 0) return { ok: false, error: "Size cannot be negative" };
  return { ok: true, value };
}
function classifyError(error) {
  const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "DOCUMENT_BLOCKED") return { stage: "blocked", code, message };
  if (CHECKPOINT_CODES.test(code)) return { stage: "checkpoint", code, message };
  return { stage: "not_applied", code, message };
}
function recoveryChoices(info) {
  if (info.phase !== "recovering" || !info.recovery) return [];
  const copy = { choice: "copy", label: "Save a recovery copy", detail: "Writes the last confirmed edits next to the original, then continues without touching it" };
  if (info.recovery.save_conflict) return [copy];
  const choices = [
    { choice: "recover", label: "Recover my edits", detail: "Continue from the last confirmed edits of the previous session" },
    { choice: "discard", label: "Use the file on disk", detail: "Discards the unsaved edits and starts from the original as it is now" }
  ];
  return info.recovery.source_matches === false ? [...choices, copy] : choices;
}
function buildLayers(model, frameId, names) {
  const parent = new Map(model.rows.map((row) => [row.path, row.parent_path]));
  const layers = [];
  let total = 0;
  for (const row of model.rows) {
    let depth = 0;
    let cursor = row.path;
    const seen = /* @__PURE__ */ new Set();
    while (cursor !== frameId && parent.get(cursor) !== null && parent.get(cursor) !== void 0 && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parent.get(cursor);
      depth += 1;
    }
    if (cursor !== frameId) continue;
    total += 1;
    if (layers.length < MAX_LAYERS) {
      layers.push({ path: row.path, depth, type: row.type, name: names.get(row.path)?.name ?? null });
    }
  }
  return { layers, truncated: total > layers.length, total };
}
function draftStatus(draft, { revision, exists }) {
  if (!exists) return "removed";
  if (draft.conflict) return "diverged";
  if (draft.base_revision !== revision) return "stale";
  return draft.text !== draft.original ? "changed" : "clean";
}
var HISTORY_STEPS, HISTORY_MIB, MAX_LAYERS, COLOR, NUMBER, QUERYABLE_BLOCKED, CHECKPOINT_CODES, FIELDS, draftKey, PanelController;
var init_panel_model = __esm({
  "editor/src/panel-model.mjs"() {
    init_errors();
    init_draft();
    init_layout();
    init_protocol();
    HISTORY_STEPS = 50;
    HISTORY_MIB = 200;
    MAX_LAYERS = 500;
    COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    NUMBER = /^-?\d+(?:\.\d+)?$/;
    QUERYABLE_BLOCKED = /* @__PURE__ */ new Set(["recovering", "blocked", "closing", "closed"]);
    CHECKPOINT_CODES = /^(?:CHECKPOINT_|INDEX_|RETENTION_|STORE_|DOCUMENT_LIMIT$)/;
    FIELDS = Object.freeze([
      { property: "content", label: "Text", kind: "text" },
      { property: "x", label: "X", kind: "number" },
      { property: "y", label: "Y", kind: "number" },
      { property: "width", label: "Width", kind: "number" },
      { property: "height", label: "Height", kind: "number" },
      { property: "fill", label: "Solid color", kind: "color" }
    ]);
    draftKey = (path, property) => `${path}\0${property}`;
    PanelController = class {
      /** @param {{document:any,renderer:any,poll_ms?:number}} options */
      constructor({ document, renderer, poll_ms = 400 }) {
        this.document = document;
        this.renderer = renderer;
        this.pollMs = poll_ms;
        this.info = document.info();
        this.render = renderer.status();
        this.model = null;
        this.modelRevision = null;
        this.index = /* @__PURE__ */ new Map();
        this.rows = /* @__PURE__ */ new Map();
        this.frameId = null;
        this.selectedPath = null;
        this.targetNode = null;
        this.drafts = /* @__PURE__ */ new Map();
        this.board = null;
        this.multiline = /* @__PURE__ */ new Set();
        this.confirmDelete = null;
        this.notice = null;
        this.busy = null;
        this.listeners = /* @__PURE__ */ new Set();
        this.refreshing = null;
        this.again = false;
        this.forceNext = false;
        this.signature = "";
        this.timer = null;
        this.unsubscribe = null;
        this.unsubscribeStatus = null;
        this.closed = false;
      }
      /** @param {()=>void} fn @returns {()=>void} */
      subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      }
      emit() {
        if (this.closed) return;
        for (const fn of this.listeners) {
          try {
            fn();
          } catch {
          }
        }
      }
      async start() {
        this.unsubscribeStatus = this.document.onStatus?.((info) => {
          if (this.closed) return;
          this.info = info;
          this.render = this.renderer.status();
          this.emit();
        });
        await this.refresh({ force: true });
        if (this.closed) return;
        this.unsubscribe = this.document.onCommit(() => void this.refresh());
        if (this.pollMs > 0) {
          this.timer = setInterval(() => void this.refresh(), this.pollMs);
          this.timer.unref?.();
        }
      }
      /** The whiteboard drafts of the owner's server: one capture request, one reset. */
      useBoard(board) {
        this.board = board;
      }
      close() {
        this.closed = true;
        clearInterval(this.timer);
        this.timer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.unsubscribeStatus?.();
        this.unsubscribeStatus = null;
        this.listeners.clear();
      }
      /** Re-read document and render state; calls coalesce into one trailing pass. */
      refresh({ force = false } = {}) {
        if (this.closed) return Promise.resolve();
        this.forceNext ||= force;
        if (this.refreshing) {
          this.again = true;
          return this.refreshing;
        }
        this.refreshing = (async () => {
          do {
            this.again = false;
            const forced = this.forceNext;
            this.forceNext = false;
            await this.refreshOnce(forced);
          } while (this.again && !this.closed);
        })().finally(() => {
          this.refreshing = null;
        });
        return this.refreshing;
      }
      async refreshOnce(force) {
        if (this.closed) return;
        const info = this.document.info();
        const render = this.renderer.status();
        const signature = JSON.stringify([info, render]);
        if (!force && signature === this.signature && this.modelRevision === info.revision) return;
        this.signature = signature;
        this.info = info;
        this.render = render;
        this.emit();
        if (!QUERYABLE_BLOCKED.has(info.phase) && (force || !this.model || this.modelRevision !== info.revision)) {
          try {
            const model = await this.document.readModel();
            if (this.closed) return;
            if (this.document.info().revision !== info.revision) {
              this.again = true;
              return;
            }
            this.setModel(model, info.revision);
            await this.loadTarget();
            if (this.closed) return;
            this.reconcileDrafts();
          } catch (error) {
            if (this.closed) return;
            this.notice = { kind: "error", stage: "query", code: error?.code ?? "INTERNAL_ERROR", message: "Document state could not be read" };
          }
        }
        this.emit();
      }
      setModel(model, revision) {
        this.model = model;
        this.modelRevision = revision;
        this.index = schemaIndex(model.roots);
        this.rows = new Map(model.rows.map((row) => [row.path, row]));
        const frames = this.frames();
        if (!frames.some((frame) => frame.id === this.frameId)) this.frameId = frames[0]?.id ?? null;
        if (this.selectedPath && !this.rows.has(this.selectedPath)) {
          this.selectedPath = null;
          this.confirmDelete = null;
        }
      }
      async loadTarget() {
        this.targetNode = null;
        const path = this.selectedPath;
        if (path?.includes("/")) {
          const node = await this.document.readNode(path);
          if (!this.closed && path === this.selectedPath) this.targetNode = node;
        }
      }
      frames() {
        return (this.model?.roots ?? []).filter((root) => root?.type === "frame").map((root) => ({
          id: root.id,
          name: root.name ?? null,
          width: this.rows.get(root.id)?.width,
          height: this.rows.get(root.id)?.height
        }));
      }
      target(path) {
        const row = this.rows.get(path) ?? null;
        const schema = this.index.get(path) ?? (path === this.selectedPath ? this.targetNode : null);
        const parentRow = row?.parent_path ? this.rows.get(row.parent_path) ?? null : null;
        return { path, schema, row, parentRow, exists: row !== null };
      }
      fieldsFor(path) {
        if (!this.model) return [];
        return describeFields(this.target(path), this.model);
      }
      /** Rebase drafts whose property is unchanged; leave real conflicts for an explicit decision. */
      reconcileDrafts() {
        for (const [key, draft] of this.drafts) {
          const target = this.target(draft.path);
          if (!target.exists || draft.conflict || draft.base_revision === this.modelRevision) continue;
          const field = this.fieldsFor(draft.path).find((item) => item.property === draft.property);
          if (field?.editable && field.value === draft.original) {
            this.drafts.set(key, { ...draft, base_revision: this.modelRevision });
          }
        }
      }
      /** Select a frame as the focus; the layers list follows it. */
      selectFrame(frameId) {
        if (!this.frames().some((frame) => frame.id === frameId)) return;
        this.frameId = frameId;
        this.emit();
      }
      /** Select a layer or whiteboard target. Pending drafts stay with their own targets. */
      async selectNode(path) {
        if (this.closed) return;
        this.confirmDelete = null;
        if (typeof path !== "string" || !this.rows.has(path)) {
          this.selectedPath = null;
          this.targetNode = null;
          this.notice = { kind: "error", stage: "not_applied", code: "TARGET_MISSING", message: "The selected element no longer exists" };
          this.emit();
          return;
        }
        this.selectedPath = path;
        let cursor = path;
        const seen = /* @__PURE__ */ new Set();
        while (this.rows.get(cursor)?.parent_path && !seen.has(cursor)) {
          seen.add(cursor);
          cursor = this.rows.get(cursor).parent_path;
        }
        if (this.frames().some((frame) => frame.id === cursor)) this.frameId = cursor;
        try {
          await this.loadTarget();
        } catch (error) {
          this.notice = { kind: "error", stage: "query", code: error?.code ?? "INTERNAL_ERROR", message: "Element data could not be read" };
        }
        this.emit();
      }
      currentFieldValue(path, property) {
        return this.fieldsFor(path).find((field) => field.property === property);
      }
      ensureDraft(path, property) {
        const key = draftKey(path, property);
        const existing = this.drafts.get(key);
        if (existing) return existing;
        const field = this.currentFieldValue(path, property);
        if (!field?.editable) throw new EditorError("FIELD_READONLY", field?.reason ?? "Field is not editable");
        return { ...newTextDraft({
          session_id: this.info.session_id,
          base_revision: this.modelRevision,
          path,
          property,
          value: field.value
        }), cursor: field.value.length };
      }
      /** Apply a native field edit event to the draft of exactly this path/property. */
      edit(path, property, event) {
        let draft;
        try {
          draft = this.ensureDraft(path, property);
        } catch {
          return;
        }
        try {
          draft = editDraft(draft, event);
          delete draft.error;
        } catch (error) {
          draft = { ...draft, conflict: true, error: error?.message ?? "Edit rejected" };
        }
        this.drafts.set(draftKey(path, property), draft);
        this.emit();
      }
      /** A text key from the pty (Tern leaves typing, deletes and plain arrows to the program): edit this field's draft. */
      key(path, property, key, { multiline = false } = {}) {
        let draft;
        try {
          draft = this.ensureDraft(path, property);
        } catch {
          return;
        }
        const event = keyEdit(draft, key, { multiline });
        if (event) this.edit(path, property, event);
      }
      undoField(path, property) {
        const key = draftKey(path, property);
        const draft = this.drafts.get(key);
        if (!draft) return;
        this.drafts.set(key, undoDraft(draft));
        this.emit();
      }
      /** Escape: drop the draft of this field and show the confirmed value again. */
      cancelField(path, property) {
        const key = draftKey(path, property);
        if (!this.drafts.delete(key)) return;
        this.emit();
      }
      setMultiline(path, property, on) {
        const key = draftKey(path, property);
        if (on) this.multiline.add(key);
        else this.multiline.delete(key);
        this.emit();
      }
      /** Explicit decision after a conflict: keep my text on top of the document as it is now. */
      keepDraft(path, property) {
        if (!this.requireCurrentModel()) return;
        const key = draftKey(path, property);
        const draft = this.drafts.get(key);
        const field = this.currentFieldValue(path, property);
        if (!draft || !field?.editable || draft.conflict) return;
        this.drafts.set(key, { ...draft, base_revision: this.info.revision, original: field.value });
        this.emit();
      }
      /** Commit one field draft as an `update` operation against the revision it was based on. */
      async applyField(path, property, { text } = {}) {
        const key = draftKey(path, property);
        if (this.busy) return;
        let draft;
        try {
          draft = this.ensureDraft(path, property);
        } catch (error) {
          this.notice = { kind: "error", ...classifyError(error) };
          this.emit();
          return;
        }
        if (text !== void 0 && text !== draft.text) {
          draft = editDraft(draft, { from: 0, to: draft.text.length, len: draft.text.length, text, cursor: text.length });
          this.drafts.set(key, draft);
        }
        const field = this.currentFieldValue(path, property);
        if (!field?.editable) {
          this.notice = { kind: "error", stage: "not_applied", code: "FIELD_READONLY", message: field?.reason ?? "Field is not editable" };
          this.emit();
          return;
        }
        let operation;
        try {
          operation = draftOperation(draft, this.info.revision);
        } catch (error) {
          this.notice = { kind: "error", stage: "not_applied", code: error.code, message: error.code === "DRAFT_STALE" ? "The document changed since this edit began; keep your text or discard it" : "The field and its draft diverged; discard the draft" };
          this.emit();
          return;
        }
        if (operation === null) {
          this.drafts.delete(key);
          this.emit();
          return;
        }
        const coerced = coerceValue(property, String(operation.props[property]));
        if (!coerced.ok) {
          this.drafts.set(key, { ...draft, error: coerced.error });
          this.emit();
          return;
        }
        const done = await this.mutate(() => this.document.applyChanges({
          session_id: draft.session_id,
          base_revision: draft.base_revision,
          operations: [{ op: "update", path, props: { [property]: coerced.value } }]
        }), `Applying ${property}`);
        if (done) this.drafts.delete(key);
        this.emit();
      }
      /** Reorder one node inside its auto-layout parent. */
      async moveNode(path, delta) {
        const move = this.reorderInfo(path);
        if (!move) return;
        const index = move.index + delta;
        if (index < 0 || index >= move.count) return;
        await this.mutate(() => this.document.applyChanges({
          session_id: this.info.session_id,
          base_revision: this.info.revision,
          operations: [{ op: "move", path, index }]
        }), "Reordering");
      }
      /** Position among siblings when the parent is an auto-layout container. */
      reorderInfo(path) {
        const row = this.rows.get(path);
        if (!row || path.includes("/") || !row.parent_path) return null;
        const parent = this.rows.get(row.parent_path);
        if (!placedByLayout(parent, row)) return null;
        const siblings = this.model.rows.filter((item) => item.parent_path === row.parent_path);
        return { index: siblings.findIndex((item) => item.path === path), count: siblings.length };
      }
      deleteReason(path) {
        if (!this.rows.has(path)) return "Element no longer exists";
        if (path.includes("/")) return "Part of a component instance";
        return null;
      }
      requestDelete(path) {
        if (this.deleteReason(path)) return;
        this.confirmDelete = { path, revision: this.info.revision };
        this.emit();
      }
      cancelDelete() {
        this.confirmDelete = null;
        this.emit();
      }
      async confirmDeletion() {
        const pending = this.confirmDelete;
        if (!pending || this.busy) return;
        this.confirmDelete = null;
        if (pending.revision !== this.info.revision) {
          this.notice = { kind: "error", stage: "not_applied", code: "REVISION_STALE", message: "The document changed; request the deletion again" };
          this.emit();
          return;
        }
        await this.mutate(() => this.document.applyChanges({
          session_id: this.info.session_id,
          base_revision: pending.revision,
          operations: [{ op: "delete", path: pending.path }]
        }), "Deleting");
      }
      requireCurrentModel() {
        if (this.modelRevision === this.document.info().revision) return true;
        this.notice = { kind: "error", stage: "query", code: "MODEL_STALE", message: "Wait for the current document fields before applying this action" };
        this.emit();
        return false;
      }
      /** Run one document command, report it, and refresh. Returns true when it succeeded. */
      async mutate(run, label, success) {
        if (this.closed) return false;
        if (this.document.info().phase === "ready" && !this.requireCurrentModel()) return false;
        this.busy = label;
        this.notice = null;
        this.emit();
        try {
          const result = await run();
          if (this.closed) return false;
          this.notice = success ? { kind: "info", message: success(result) } : null;
          return true;
        } catch (error) {
          if (this.closed) return false;
          this.notice = { kind: "error", ...classifyError(error) };
          return false;
        } finally {
          this.busy = null;
          await this.refresh({ force: true });
        }
      }
      docUndo() {
        return this.mutate(() => this.document.undo(this.expected()), "Undoing", () => "Undid the last document step");
      }
      docRedo() {
        return this.mutate(() => this.document.redo(this.expected()), "Redoing", () => "Redid the next document step");
      }
      expected() {
        return { session_id: this.info.session_id, base_revision: this.info.revision };
      }
      pendingDrafts() {
        return [...this.drafts.values()].map((draft) => ({ draft, status: draftStatus(draft, { revision: this.info.revision, exists: this.rows.has(draft.path) }) })).filter((item) => item.status !== "clean");
      }
      /** Save publishes only confirmed state; pending field edits must be resolved first. */
      async save() {
        if (this.pendingDrafts().length > 0) {
          this.notice = { kind: "error", stage: "not_applied", code: "DRAFTS_PENDING", message: "Apply or discard pending field edits before saving" };
          this.emit();
          return;
        }
        await this.mutate(() => this.document.saveOriginal(this.expected()), "Saving", (result) => result.saved ? `Saved revision ${result.revision}` : "Nothing to save");
      }
      async saveCopy() {
        await this.mutate(() => this.document.saveRecoveryCopy(this.expected()), "Saving a copy", (result) => `Recovery copy written to ${result.path}`);
      }
      async resolveRecovery(choice) {
        await this.mutate(() => this.document.resolveRecovery(choice), "Resolving recovery", (result) => result.recovery_copy ? `Recovery copy written to ${result.recovery_copy}` : "Recovery resolved");
      }
      /** Confirm the moves and resizes made on the whiteboard: one fresh capture, one document step. */
      async applyBoard() {
        if (this.busy || !this.board) return;
        await this.mutate(() => this.board.request(), "Reading the board", (outcome) => {
          const restored = outcome.reconcile ? " Some board shapes were missing and are restored." : "";
          if (outcome.applied) return `Applied ${outcome.changes} board change${outcome.changes === 1 ? "" : "s"} (revision ${outcome.revision}).${restored}`;
          if (outcome.reconcile) return "The board was missing some shapes, so it was rebuilt and nothing was applied. Move or resize again to apply.";
          return "The board has no changes to apply";
        });
      }
      /** Drop the whiteboard drafts: the board rebuilds its own shapes from the document, which is not touched. */
      cancelBoard() {
        if (this.busy || !this.board) return;
        this.board.reset();
        this.notice = { kind: "info", message: "Board edits discarded; the board shows the document again" };
        this.emit();
      }
      /** @returns {object} Plain snapshot of the document state. */
      view() {
        const info = this.closed ? { ...this.info, phase: "closed" } : this.document.info();
        const render = this.renderer.status();
        const names = this.index;
        const frames = this.frames();
        const layerPage = this.frameId && this.model ? buildLayers(this.model, this.frameId, names) : { layers: [], truncated: false, total: 0 };
        const editable = info.phase === "ready" && this.modelRevision === info.revision && !this.busy;
        const selected = this.selectedPath && this.rows.has(this.selectedPath) ? { path: this.selectedPath, type: this.rows.get(this.selectedPath).type, name: this.index.get(this.selectedPath)?.name ?? null } : null;
        const fields = selected ? this.fieldsFor(selected.path).map((field) => {
          const key = draftKey(selected.path, field.property);
          const draft = this.drafts.get(key);
          return {
            ...field,
            key,
            multiline: this.multiline.has(key) || (draft?.text ?? field.value).includes("\n"),
            draft: draft ? {
              text: draft.text,
              cursor: draft.cursor,
              error: draft.error ?? null,
              status: draftStatus(draft, { revision: info.revision, exists: true }),
              current: field.value
            } : null
          };
        }) : [];
        return {
          info,
          phase: info.phase,
          activity: activityState(info, render),
          busy: this.busy,
          editable,
          notice: this.notice,
          render: {
            rendered_revision: render.rendered_revision,
            error: render.error,
            pending: render.error === null && render.rendered_revision !== info.revision
          },
          frames,
          frameId: this.frameId,
          layers: layerPage.layers,
          layersTruncated: layerPage.truncated,
          layersTotal: layerPage.total,
          selected,
          fields,
          reorder: selected && editable ? this.reorderInfo(selected.path) : null,
          deleteReason: selected ? this.deleteReason(selected.path) : null,
          confirmDelete: this.confirmDelete,
          board: this.board !== null,
          pending: this.pendingDrafts().map(({ draft, status }) => ({
            path: draft.path,
            property: draft.property,
            status,
            label: this.index.get(draft.path)?.name ?? draft.path
          })),
          recovery: recoveryChoices(info),
          retention: `History keeps the last ${HISTORY_STEPS} steps or ${HISTORY_MIB} MiB; the current and last saved steps are always kept.`
        };
      }
    };
  }
});

// editor/src/reorder.mjs
function reorderIndex({ layout, parent, siblings, path, dropped }) {
  const x = dropped.x + dropped.width / 2;
  const y = dropped.y + dropped.height / 2;
  if (x < parent.x || x > parent.x + parent.width || y < parent.y || y > parent.y + parent.height) return null;
  const horizontal = layout === "horizontal";
  const at = horizontal ? x : y;
  const centre = (box) => horizontal ? box.x + box.width / 2 : box.y + box.height / 2;
  const landing = (sibling) => sibling.enabled !== false && sibling.absolute !== true;
  const others = siblings.filter((sibling) => sibling.path !== path);
  const before = others.findIndex((sibling) => landing(sibling) && centre(sibling) >= at);
  const index = before === -1 ? others.length : before;
  const current = siblings.findIndex((sibling) => sibling.path === path);
  if (index === current) return null;
  if (index > current && !others.slice(current, index).some(landing)) return null;
  return index;
}
var init_reorder = __esm({
  "editor/src/reorder.mjs"() {
  }
});

// editor/src/geometry.mjs
function geometryError(code, message, details2) {
  return new EditorError(code, message, details2);
}
function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw geometryError("GEOMETRY_INVALID", `${name} must be finite`);
  }
  return value;
}
function opacityOf(node) {
  if (node.opacity === void 0) return 1;
  return Math.max(0, Math.min(1, finite(node.opacity, "opacity")));
}
function hasComplexTransform(node) {
  if (typeof node.rotation === "number" && node.rotation !== 0) return true;
  if (node.transform !== void 0 && node.transform !== null) return true;
  if (node.scaleX !== void 0 && node.scaleX !== 1) return true;
  if (node.scaleY !== void 0 && node.scaleY !== 1) return true;
  return false;
}
function intersection(bounds, clip) {
  const left = Math.max(bounds.x, clip.x);
  const top = Math.max(bounds.y, clip.y);
  const right = Math.min(bounds.x + bounds.width, clip.x + clip.width);
  const bottom = Math.min(bounds.y + bounds.height, clip.y + clip.height);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}
function worldGeometry(row, ancestors) {
  if (!row || typeof row !== "object" || !Array.isArray(ancestors)) {
    throw geometryError("GEOMETRY_INVALID", "A row and its ancestor list are required");
  }
  let offsetX = 0;
  let offsetY = 0;
  let opacity = 1;
  let visible = true;
  let ambiguous = false;
  const clips = [];
  for (const ancestor of ancestors) {
    offsetX += finite(ancestor.x, "ancestor.x");
    offsetY += finite(ancestor.y, "ancestor.y");
    opacity *= opacityOf(ancestor);
    visible = visible && ancestor.visible !== false && ancestor.enabled !== false;
    ambiguous = ambiguous || hasComplexTransform(ancestor);
    if (ancestor.clip === true) {
      clips.push({
        x: offsetX,
        y: offsetY,
        width: finite(ancestor.width, "ancestor.width"),
        height: finite(ancestor.height, "ancestor.height")
      });
    }
  }
  const x = offsetX + finite(row.x, "row.x");
  const y = offsetY + finite(row.y, "row.y");
  const width = finite(row.width, "row.width");
  const height = finite(row.height, "row.height");
  opacity *= opacityOf(row);
  visible = visible && row.visible !== false && row.enabled !== false && opacity > 0 && width > 0 && height > 0;
  ambiguous = ambiguous || hasComplexTransform(row);
  let clip = null;
  for (const ancestorClip of clips) {
    clip = intersection(clip ?? { x, y, width, height }, ancestorClip);
  }
  if (clip && (clip.width === 0 || clip.height === 0)) visible = false;
  return {
    x,
    y,
    width,
    height,
    clip,
    opacity,
    visible,
    captures: visible && !ambiguous,
    ambiguous
  };
}
function assertTag(view, capture) {
  if (!view || !capture || capture.view_id !== view.view_id || capture.view_generation !== view.view_generation || capture.scene_revision !== view.scene_revision) {
    throw geometryError("GEOMETRY_CAPTURE_STALE", "Geometry capture no longer belongs to the current view");
  }
  if (!Array.isArray(capture.changes)) {
    throw geometryError("GEOMETRY_INVALID", "Geometry capture changes must be an array");
  }
}
function rowIndex(model) {
  if (!model || !Array.isArray(model.rows) || !Array.isArray(model.roots)) {
    throw geometryError("GEOMETRY_INVALID", "Model must contain roots and rows");
  }
  return new Map(model.rows.map((row) => [row.path, row]));
}
function ancestorsOf(row, rows) {
  const ancestors = [];
  const seen = /* @__PURE__ */ new Set([row.path]);
  let parentPath = row.parent_path;
  while (parentPath !== null && parentPath !== void 0) {
    if (seen.has(parentPath)) throw geometryError("GEOMETRY_INVALID", "Model ancestry is cyclic");
    seen.add(parentPath);
    const parent = rows.get(parentPath);
    if (!parent) throw geometryError("GEOMETRY_INVALID", "Model ancestry is incomplete", { path: row.path, parent_path: parentPath });
    ancestors.unshift(parent);
    parentPath = parent.parent_path;
  }
  return ancestors;
}
function schemaIndex2(roots) {
  const index = /* @__PURE__ */ new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.id === "string") {
      if (index.has(node.id)) index.set(node.id, null);
      else index.set(node.id, node);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  for (const root of roots) visit(root);
  return index;
}
function changed(left, right) {
  return Math.abs(left - right) > EPSILON;
}
function reorderTarget(rows, parent, row, dropped) {
  const parentWorld = worldGeometry(parent, ancestorsOf(parent, rows));
  if (!parentWorld.captures) return null;
  const siblings = [...rows.values()].filter((item) => item.parent_path === parent.path).map((item) => ({ path: item.path, enabled: item.enabled !== false, absolute: !placedByLayout(parent, item), ...worldGeometry(item, ancestorsOf(item, rows)) }));
  return reorderIndex({ layout: layoutOf(parent), parent: parentWorld, siblings, path: row.path, dropped });
}
function boundToVariable(content, model) {
  const match = /^\$(\S+)$/.exec(content);
  const variables = model.variables?.variables ?? model.variables ?? {};
  return match !== null && Object.hasOwn(variables, match[1]);
}
function boundTextPaths(model) {
  const bound = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "text" && typeof node.id === "string" && typeof node.content === "string" && boundToVariable(node.content, model)) bound.add(node.id);
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  };
  for (const root of model.roots ?? []) visit(root);
  return bound;
}
function textChanges(texts, rows, schemas, model) {
  if (!Array.isArray(texts)) throw geometryError("GEOMETRY_INVALID", "Text changes must be an array");
  const operations = [];
  for (const item of texts) {
    if (!item || typeof item.path !== "string" || item.path.length === 0 || typeof item.content !== "string" || typeof item.base !== "string") {
      throw geometryError("GEOMETRY_INVALID", "Every text change requires a path, a content string and the base string it started from");
    }
    if (!rows.has(item.path)) throw geometryError("GEOMETRY_TARGET_MISSING", "Text target is absent", { path: item.path });
    const schema = schemas.get(item.path);
    const content = schema?.content;
    const plain = schema?.type === "text" && (content === void 0 || typeof content === "string" && !boundToVariable(content, model));
    if (!plain) {
      throw geometryError("GEOMETRY_NOT_TEXT", "Only a text node with plain text can be edited on the board. Use the panel fields.", { path: item.path });
    }
    const current = content ?? "";
    if (current === item.content) continue;
    if (current !== item.base) {
      throw geometryError("GEOMETRY_TEXT_CONFLICT", "The text of this node changed after the board started from it", { path: item.path, current });
    }
    operations.push({ op: "update", path: item.path, props: { content: item.content } });
  }
  return operations;
}
function geometryChanges({ model, view, capture }) {
  assertTag(view, capture);
  const rows = rowIndex(model);
  const schemas = schemaIndex2(model.roots);
  const reordered = /* @__PURE__ */ new Set();
  const operations = [];
  for (const change of capture.changes) {
    if (!change || typeof change.path !== "string" || change.path.length === 0) {
      throw geometryError("GEOMETRY_INVALID", "Every geometry change requires a path");
    }
    const row = rows.get(change.path);
    if (!row) throw geometryError("GEOMETRY_TARGET_MISSING", "Geometry target is absent", { path: change.path });
    const ancestors = ancestorsOf(row, rows);
    const world = worldGeometry(row, ancestors);
    if (!world.captures) {
      throw geometryError("GEOMETRY_AMBIGUOUS", "This element is hidden, rotated or scaled, so its board shape does not map to the document. Use the panel fields.", { path: change.path });
    }
    if (world.clip && (changed(world.clip.x, world.x) || changed(world.clip.y, world.y) || changed(world.clip.width, world.width) || changed(world.clip.height, world.height))) {
      throw geometryError("GEOMETRY_AMBIGUOUS", "The board shows only the clipped part of this element. Use the panel fields.", { path: change.path });
    }
    if (change.rotation !== void 0 && change.rotation !== 0) {
      throw geometryError("GEOMETRY_AMBIGUOUS", "Rotating on the board does not change the document. Use the panel fields.", { path: change.path });
    }
    const x = finite(change.x, "change.x");
    const y = finite(change.y, "change.y");
    const width = finite(change.w, "change.w");
    const height = finite(change.h, "change.h");
    if (width < 0 || height < 0) throw geometryError("GEOMETRY_INVALID", "Captured size cannot be negative");
    const moved = changed(x, world.x) || changed(y, world.y);
    const parent = row.parent_path === null || row.parent_path === void 0 ? null : rows.get(row.parent_path);
    const widthChanged = changed(width, world.width);
    const heightChanged = changed(height, world.height);
    if (moved && placedByLayout(parent, row)) {
      const index = widthChanged || heightChanged || row.path.includes("/") || reordered.has(parent.path) ? null : reorderTarget(rows, parent, row, { x, y, width, height });
      if (index === null) {
        throw geometryError(
          "GEOMETRY_CONTROLLED_BY_LAYOUT",
          "Parent layout controls this child position: drop it between its siblings to reorder it.",
          { path: row.path, parent_path: parent.path, layout: layoutOf(parent) }
        );
      }
      reordered.add(parent.path);
      operations.push({ op: "move", path: row.path, index });
      continue;
    }
    const props = {};
    if (moved) {
      props.x = finite(row.x, "row.x") + (x - world.x);
      props.y = finite(row.y, "row.y") + (y - world.y);
    }
    if (widthChanged || heightChanged) {
      const schema = schemas.get(row.path);
      if (!schema || widthChanged && typeof schema.width !== "number" || heightChanged && typeof schema.height !== "number") {
        throw geometryError(
          "GEOMETRY_SIZE_AMBIGUOUS",
          "This size is automatic (fit, fill or a variable), so the board cannot set it. Use the panel fields.",
          { path: row.path }
        );
      }
      if (widthChanged) props.width = width;
      if (heightChanged) props.height = height;
    }
    if (Object.keys(props).length > 0) operations.push({ op: "update", path: row.path, props });
  }
  if (capture.texts !== void 0) operations.push(...textChanges(capture.texts, rows, schemas, model));
  if (operations.length > MAX_OPERATIONS2) {
    throw geometryError("GEOMETRY_TOO_MANY", `Apply at most ${MAX_OPERATIONS2} board changes at a time`, { changes: operations.length });
  }
  return operations;
}
var EPSILON;
var init_geometry = __esm({
  "editor/src/geometry.mjs"() {
    init_errors();
    init_protocol();
    init_layout();
    init_reorder();
    EPSILON = 1e-3;
  }
});

// editor/src/render.mjs
import { createHash as createHash3, randomUUID as randomUUID3 } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open as open2, readFile as readFile3, rm as rm2, stat as stat2 } from "node:fs/promises";
import { join as join4 } from "node:path";
function renderError(code, message, details2) {
  return new EditorError(code, message, details2);
}
function assertOptions(document, dir) {
  if (!document || typeof document.info !== "function" || typeof document.readModel !== "function" || typeof document.withEngine !== "function" || typeof document.onCommit !== "function") {
    throw renderError("RENDER_OPTIONS_INVALID", "document does not implement the renderer contract");
  }
  if (typeof dir !== "string" || dir.length === 0) {
    throw renderError("RENDER_OPTIONS_INVALID", "dir must be a nonempty string");
  }
}
function safeFrameId(id) {
  return typeof id === "string" && id.length > 0 && !/[\\/:\u0000-\u001f]/.test(id) && !id.includes("..");
}
function stableHash(value) {
  return createHash3("sha256").update(JSON.stringify(value)).digest("hex");
}
function scaleFor(bounds, maxSide) {
  const largest = Math.max(bounds.width, bounds.height);
  if (!Number.isFinite(largest) || largest <= 0) {
    throw renderError("RENDER_BOUNDS_INVALID", "Frame must have positive finite bounds", { frame_id: bounds.id });
  }
  const scale = Math.min(1, MAX_SIDE / largest, maxSide / largest);
  const quantized = Math.floor(scale * 1e6) / 1e6;
  if (!Number.isFinite(quantized) || quantized <= 0) {
    throw renderError("RENDER_SCALE_INVALID", "Calculated render scale is invalid", { frame_id: bounds.id });
  }
  return quantized;
}
function scaleKey(scale) {
  return scale.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
function currentRevision(document) {
  return document.info().revision;
}
function normalizeRows(value) {
  if (!value || !Array.isArray(value.rows)) {
    throw renderError("RENDER_PROTOCOL", "Engine returned invalid render metadata");
  }
  return value.rows.map((row) => {
    if (!row || typeof row.path !== "string" || typeof row.type !== "string") {
      throw renderError("RENDER_PROTOCOL", "Engine returned an invalid metadata row");
    }
    return normalizeRow(row);
  });
}
function groupRows(rows, frameIds) {
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const groups = new Map([...frameIds].map((id) => [id, []]));
  for (const row of rows) {
    let root = row;
    const seen = /* @__PURE__ */ new Set();
    while (root.parent_path !== null && root.parent_path !== void 0) {
      if (seen.has(root.path)) {
        throw renderError("RENDER_PROTOCOL", "Engine metadata ancestry is cyclic");
      }
      seen.add(root.path);
      root = byPath.get(root.parent_path);
      if (!root) break;
    }
    const group = root && groups.get(root.path);
    if (group) group.push(row);
  }
  return groups;
}
function projectionRows(rows, frameId) {
  const byPath = new Map(rows.map((row) => [row.path, row]));
  return rows.map((row) => {
    const ancestors = [];
    const seen = /* @__PURE__ */ new Set([row.path]);
    let parentPath = row.parent_path;
    while (parentPath !== null && parentPath !== void 0) {
      if (seen.has(parentPath)) throw renderError("RENDER_PROTOCOL", "Projection ancestry is cyclic");
      seen.add(parentPath);
      const parent2 = byPath.get(parentPath);
      if (!parent2) throw renderError("RENDER_PROTOCOL", "Projection ancestry is incomplete");
      ancestors.unshift(parent2);
      parentPath = parent2.parent_path;
    }
    const parent = ancestors.at(-1);
    return {
      path: row.path,
      parent_path: row.parent_path,
      type: row.type,
      layout: layoutOf(row),
      geometry: worldGeometry(row, ancestors),
      movable: parent !== void 0 && !placedByLayout(parent, row),
      reorderable: parent !== void 0 && placedByLayout(parent, row) && !row.path.includes("/"),
      resizable: { width: typeof row.schema?.width === "number", height: typeof row.schema?.height === "number" },
      frame_id: frameId,
      ...row.type === "text" && !row.text_bound && !row.path.includes("/") && typeof row.schema?.content === "string" && row.schema.content.length <= MAX_BOARD_TEXT ? { text: row.schema.content, ...typeof row.schema.fontSize === "number" ? { font_size: row.schema.fontSize } : {} } : {}
    };
  });
}
function metadataBody() {
  return `const rows=Get((n,c)=>{
 const {children,...schema}=n;
 const b=c.bounds;
 return {path:n.id,parent_path:c.parentCtx?c.parentCtx.node.id:null,type:n.type,
  layout:typeof n.layout==='string'?n.layout:null,layout_position:n.layoutPosition,enabled:n.enabled,
  x:b.x,y:b.y,width:b.width,height:b.height,
  visible:n.visible,opacity:n.opacity,clip:n.clip,rotation:n.rotation,transform:n.transform,
  scaleX:n.scaleX,scaleY:n.scaleY,schema};
},{resolveVariables:true,resolveInstances:true});
return {rows};`;
}
function exportBody(ids, dir, scale) {
  return `Export(${JSON.stringify(ids)},'png',${JSON.stringify(dir)},{scale:${scale}});return {ids:${JSON.stringify(ids)}};`;
}
async function requireFile(path, frameId) {
  try {
    await access(path);
  } catch (cause) {
    throw renderError("RENDER_MISSING", "Engine did not produce the requested PNG", { frame_id: frameId, cause });
  }
}
function pngSize(bytes, frameId) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw renderError("RENDER_INVALID_PNG", "Engine produced an invalid PNG", { frame_id: frameId });
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
async function validateCachedImage(image, frameId) {
  let handle;
  try {
    const metadata = await stat2(image.path);
    if (metadata.size !== image.bytes) {
      throw renderError("RENDER_MISSING", "Current rendered PNG has an invalid size", { frame_id: frameId });
    }
    handle = await open2(image.path, "r");
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("hex") !== "89504e470d0a1a0a") {
      throw renderError("RENDER_MISSING", "Current rendered PNG has an invalid header", { frame_id: frameId });
    }
  } catch (cause) {
    if (cause?.code === "RENDER_MISSING") throw cause;
    throw renderError("RENDER_MISSING", "Current rendered PNG is missing", { frame_id: frameId, cause });
  } finally {
    if (handle) await handle.close();
  }
  return image;
}
function createRenderer({ document, dir }) {
  assertOptions(document, dir);
  return new Renderer(document, dir);
}
var MAX_SIDE, MAX_PAGE_NODES, MAX_PAGE_BYTES, MAX_BOARD_TEXT, Renderer;
var init_render = __esm({
  "editor/src/render.mjs"() {
    init_errors();
    init_geometry();
    init_layout();
    MAX_SIDE = 4096;
    MAX_PAGE_NODES = 64;
    MAX_PAGE_BYTES = 32 * 1024;
    MAX_BOARD_TEXT = 1e3;
    Renderer = class {
      constructor(document, dir) {
        this.document = document;
        this.dir = dir;
        this.closed = false;
        this.tail = Promise.resolve();
        this.pending = /* @__PURE__ */ new Map();
        this.frames = /* @__PURE__ */ new Map();
        this.invalidFrames = /* @__PURE__ */ new Set();
        this.renderedRevision = null;
        this.refreshingRevision = null;
        this.lastExported = [];
        this.affectedFrameIds = null;
        this.error = null;
        this.ownedOutputs = /* @__PURE__ */ new Map();
        this.reservedPaths = /* @__PURE__ */ new Set();
        this.publications = /* @__PURE__ */ new Set();
        this.closePromise = null;
        this.unsubscribe = document.onCommit((info) => {
          void this.refresh(info.revision).catch(() => {
          });
        });
      }
      state() {
        return {
          rendered_revision: this.renderedRevision,
          refreshing_revision: this.refreshingRevision,
          error: this.error ? { ...this.error } : null,
          frame_ids: [...this.frames.keys()],
          exported_frame_ids: [...this.lastExported],
          affected_frame_ids: this.affectedFrameIds === null ? null : [...this.affectedFrameIds]
        };
      }
      setError(error) {
        this.error = {
          code: typeof error?.code === "string" ? error.code : "RENDER_FAILED",
          message: error instanceof Error ? error.message : String(error)
        };
      }
      enqueue(fn) {
        const operation = this.tail.then(fn);
        this.tail = operation.then(() => void 0, () => void 0);
        return operation;
      }
      async reserveImages(nodes) {
        for (const node of nodes) {
          const path = node.image?.path;
          if (!path || this.reservedPaths.has(path)) continue;
          const image = await open2(path, "r+");
          try {
            await image.sync();
          } finally {
            await image.close();
          }
          const reservation = await open2(`${path}.published`, "a", 384);
          try {
            await reservation.sync();
          } finally {
            await reservation.close();
          }
          this.reservedPaths.add(path);
        }
      }
      async cleanOutputs() {
        for (const [path, owned] of this.ownedOutputs) {
          try {
            await access(`${path}.published`);
            continue;
          } catch (error) {
            if (error?.code !== "ENOENT") continue;
          }
          let current;
          try {
            current = await stat2(path);
          } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
          }
          if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => current[key] === owned[key])) {
            await rm2(path, { force: true });
          }
        }
        this.ownedOutputs.clear();
      }
      async exportFrames(engine, descriptors, revision, maxSide) {
        const groups = /* @__PURE__ */ new Map();
        for (const descriptor of descriptors) {
          const scale = scaleFor(descriptor.bounds, maxSide);
          const key = scaleKey(scale);
          if (!groups.has(key)) groups.set(key, { scale, descriptors: [] });
          groups.get(key).descriptors.push(descriptor);
        }
        const images = /* @__PURE__ */ new Map();
        for (const group of groups.values()) {
          if (this.closed || currentRevision(this.document) !== revision) return { stale: true, images };
          const batchDir = join4(this.dir, `.batch-${randomUUID3()}`);
          await mkdir(this.dir, { recursive: true });
          await mkdir(batchDir);
          try {
            if (this.closed) return { stale: true, images };
            const ids = group.descriptors.map((descriptor) => descriptor.id);
            const { value } = await engine.exec(exportBody(ids, batchDir, group.scale), { kind: "read" });
            if (this.closed) return { stale: true, images };
            if (!value || !Array.isArray(value.ids) || value.ids.length !== ids.length) {
              throw renderError("RENDER_PROTOCOL", "Engine returned invalid export confirmation");
            }
            for (const descriptor of group.descriptors) {
              const temporary = join4(batchDir, `${descriptor.id}.png`);
              await requireFile(temporary, descriptor.id);
              const bytes = await readFile3(temporary);
              const size = pngSize(bytes, descriptor.id);
              const path = join4(this.dir, `${descriptor.key}-${scaleKey(group.scale)}.png`);
              let owned = this.ownedOutputs.has(path);
              try {
                await copyFile(temporary, path, constants.COPYFILE_EXCL);
                owned = true;
              } catch (error) {
                if (error?.code !== "EEXIST") throw error;
                try {
                  await validateCachedImage({ path, bytes: bytes.length }, descriptor.id);
                } catch {
                  await copyFile(temporary, path);
                }
              }
              if (owned) this.ownedOutputs.set(path, await stat2(path));
              images.set(descriptor.id, {
                path,
                scale: group.scale,
                width: size.width,
                height: size.height,
                bytes: bytes.length
              });
            }
          } finally {
            await rm2(batchDir, { recursive: true, force: true });
          }
        }
        return { stale: false, images };
      }
      async runRefresh(revision) {
        if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw renderError("RENDER_REVISION_INVALID", "revision must be a nonnegative safe integer");
        }
        if (this.renderedRevision === revision && this.invalidFrames.size === 0 && !this.error) return this.state();
        if (currentRevision(this.document) !== revision) return this.state();
        this.refreshingRevision = revision;
        this.affectedFrameIds = null;
        this.error = null;
        try {
          const model = await this.document.readModel();
          if (this.closed || currentRevision(this.document) !== revision) return this.state();
          const rootRows = new Map(model.rows.map((row) => [row.path, row]));
          const roots = model.roots.filter((root) => root && root.type === "frame");
          const frameIds = /* @__PURE__ */ new Set();
          const bounds = /* @__PURE__ */ new Map();
          for (const root of roots) {
            if (!safeFrameId(root.id)) {
              throw renderError("RENDER_FRAME_ID", "Frame ID cannot be used for an official export", { frame_id: root.id });
            }
            const row = rootRows.get(root.id);
            if (!row) throw renderError("RENDER_PROTOCOL", "Top-level frame has no resolved bounds", { frame_id: root.id });
            frameIds.add(root.id);
            bounds.set(root.id, {
              id: root.id,
              x: row.x,
              y: row.y,
              width: row.width,
              height: row.height
            });
          }
          const result = await this.document.withEngine(revision, async (engine) => {
            const metadata = normalizeRows((await engine.exec(metadataBody(), { kind: "measure" })).value);
            const bound = boundTextPaths(model);
            for (const row of metadata) if (bound.has(row.path)) row.text_bound = true;
            if (this.closed || currentRevision(this.document) !== revision) return { stale: true };
            const groups = groupRows(metadata, frameIds);
            const nextFrames = /* @__PURE__ */ new Map();
            const dirty = [];
            for (const id of frameIds) {
              const rows = groups.get(id);
              const content = rows.map((row) => ({
                path: row.path,
                parent_path: row.parent_path,
                type: row.type,
                schema: row.schema
              }));
              const key = stableHash(content);
              const previous = this.frames.get(id);
              const descriptor = { id, key, bounds: bounds.get(id), rows };
              let reusable = previous && previous.key === key && previous.images.size > 0 && !this.invalidFrames.has(id);
              if (reusable) {
                for (const image of previous.images.values()) {
                  try {
                    await validateCachedImage(image, id);
                  } catch {
                    reusable = false;
                    break;
                  }
                }
              }
              if (reusable) {
                nextFrames.set(id, { ...descriptor, images: new Map(previous.images) });
              } else {
                nextFrames.set(id, { ...descriptor, images: /* @__PURE__ */ new Map() });
                dirty.push(descriptor);
              }
            }
            if (this.closed || currentRevision(this.document) !== revision) return { stale: true };
            this.affectedFrameIds = dirty.map((descriptor) => descriptor.id);
            const exported = await this.exportFrames(engine, dirty, revision, MAX_SIDE);
            if (exported.stale) return { stale: true };
            for (const descriptor of dirty) {
              const image = exported.images.get(descriptor.id);
              if (!image) throw renderError("RENDER_MISSING", "No current image was published", { frame_id: descriptor.id });
              nextFrames.get(descriptor.id).images.set(scaleKey(image.scale), image);
            }
            return { stale: false, nextFrames, dirty: dirty.map((descriptor) => descriptor.id) };
          });
          if (result.stale || currentRevision(this.document) !== revision || this.closed) return this.state();
          this.frames = result.nextFrames;
          this.invalidFrames.clear();
          this.lastExported = result.dirty;
          this.renderedRevision = revision;
          this.error = null;
          return this.state();
        } catch (error) {
          if (!this.closed) this.setError(error);
          throw error;
        } finally {
          if (this.refreshingRevision === revision) this.refreshingRevision = null;
        }
      }
      /** @param {number} revision @returns {Promise<ReturnType<Renderer['state']>>} */
      refresh(revision) {
        const existing = this.pending.get(revision);
        if (existing) return existing;
        const operation = this.enqueue(() => this.runRefresh(revision));
        this.pending.set(revision, operation);
        void operation.finally(() => {
          if (this.pending.get(revision) === operation) this.pending.delete(revision);
        }).catch(() => {
        });
        return operation;
      }
      async renderRequestedScale(frame, maxSide) {
        const scale = scaleFor(frame.bounds, maxSide);
        const key = scaleKey(scale);
        const cached = frame.images.get(key);
        if (cached) {
          try {
            await validateCachedImage(cached, frame.id);
            if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
            return cached;
          } catch (error) {
            if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
            frame.images.clear();
            this.invalidFrames.add(frame.id);
            this.setError(error);
            throw error;
          }
        }
        const revision = this.renderedRevision;
        const result = await this.document.withEngine(revision, (engine) => this.exportFrames(
          engine,
          [{ id: frame.id, key: frame.key, bounds: frame.bounds }],
          revision,
          maxSide
        ));
        if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
        if (result.stale || currentRevision(this.document) !== revision) {
          throw renderError("RENDER_NOT_CURRENT", "Requested image revision is no longer current");
        }
        const image = result.images.get(frame.id);
        if (!image) throw renderError("RENDER_MISSING", "No current image was published", { frame_id: frame.id });
        frame.images.set(key, image);
        return image;
      }
      /**
       * Return an official current PNG, rendering a smaller engine-owned scale when requested.
       * @param {{frame_id:string,revision:number,max_side:number}} request
       * @returns {Promise<{frame_id:string,revision:number,path:string,width:number,height:number,scale:number,key:string}>}
       */
      frameImage({ frame_id: frameId, revision, max_side: maxSide }) {
        return this.enqueue(async () => {
          if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
          if (!Number.isFinite(maxSide) || maxSide <= 0) {
            throw renderError("RENDER_SCALE_INVALID", "max_side must be a positive finite number");
          }
          if (revision !== this.renderedRevision || revision !== currentRevision(this.document)) {
            throw renderError("RENDER_NOT_CURRENT", "An old image cannot represent the requested revision");
          }
          const frame = this.frames.get(frameId);
          if (!frame) throw renderError("RENDER_FRAME_MISSING", "frame_id is not a current top-level frame");
          const image = await this.renderRequestedScale(frame, Math.min(MAX_SIDE, maxSide));
          if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
          return {
            frame_id: frameId,
            revision,
            path: image.path,
            width: image.width,
            height: image.height,
            scale: image.scale,
            key: frame.key
          };
        });
      }
      /**
       * One bounded page of `allNodes`: at most 64 nodes and 32 KiB, so the Luau window never decodes more.
       * @param {object[]} allNodes
       * @param {string} frameId the focus the page is tagged with
       * @param {number|null|undefined} cursor
       */
      page(allNodes, frameId, cursor) {
        const start = cursor === null || cursor === void 0 ? 0 : cursor;
        if (!Number.isSafeInteger(start) || start < 0 || start > allNodes.length) {
          throw renderError("RENDER_CURSOR_INVALID", "Projection cursor is invalid");
        }
        const nodes = [];
        let index = start;
        while (index < allNodes.length && nodes.length < MAX_PAGE_NODES) {
          const candidate = [...nodes, allNodes[index]];
          const candidateNext = index + 1 < allNodes.length ? index + 1 : null;
          const page = {
            frame_id: frameId,
            revision: this.renderedRevision,
            nodes: candidate,
            cursor: start,
            next_cursor: candidateNext
          };
          if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_PAGE_BYTES) {
            if (nodes.length === 0) {
              throw renderError("RENDER_PAGE_LIMIT", "One projection node exceeds the 32 KiB page limit");
            }
            break;
          }
          nodes.push(allNodes[index]);
          index += 1;
        }
        return {
          frame_id: frameId,
          revision: this.renderedRevision,
          nodes,
          cursor: start,
          next_cursor: index < allNodes.length ? index : null
        };
      }
      /**
       * Return one bounded page of focused-frame projection metadata.
       * @param {{frame_id:string,cursor:number|null}} request
       * @returns {{frame_id:string,revision:number,nodes:any[],cursor:number,next_cursor:number|null}}
       */
      projection({ frame_id: frameId, cursor }) {
        if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
        const frame = this.frames.get(frameId);
        if (!frame || this.renderedRevision === null) {
          throw renderError("RENDER_FRAME_MISSING", "frame_id is not in the current rendered projection");
        }
        return this.page(projectionRows(frame.rows, frameId), frameId, cursor);
      }
      /**
       * Return one bounded page of the top-level frames with their page boxes and published PNG, so the whiteboard can
       * show every frame as an image. A frame whose image is not available has `image:null`; it is never dropped.
       * Reserve each returned PNG durably before exposing its path; pending refreshes do not delay this page.
       * @param {{frame_id:string,cursor:number|null}} request frame_id only tags the page with the view's focus
       * @returns {Promise<{frame_id:string,revision:number,nodes:any[],cursor:number,next_cursor:number|null}>}
       */
      async frameList({ frame_id: frameId, cursor }) {
        if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
        if (this.renderedRevision === null) throw renderError("RENDER_FRAME_MISSING", "No rendered projection yet");
        const nodes = [...this.frames.values()].map((frame) => {
          const image = [...frame.images.values()].sort((a, b) => b.scale - a.scale)[0];
          const root = frame.rows.find((row) => row.path === frame.id);
          return {
            id: frame.id,
            x: frame.bounds.x,
            y: frame.bounds.y,
            w: frame.bounds.width,
            h: frame.bounds.height,
            key: frame.key,
            fill: root?.schema?.fill !== void 0 && root?.schema?.fill !== null,
            image: image ? { path: image.path, width: image.width, height: image.height } : null
          };
        });
        const page = this.page(nodes, frameId, cursor);
        const reservation = this.reserveImages(page.nodes);
        this.publications.add(reservation);
        try {
          await reservation;
          if (this.closed) throw renderError("RENDER_CLOSED", "Renderer is closed");
          return page;
        } finally {
          this.publications.delete(reservation);
        }
      }
      /** @returns {ReturnType<Renderer['state']>} */
      status() {
        return this.state();
      }
      /** @returns {Promise<void>} */
      close() {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        this.refreshingRevision = null;
        this.unsubscribe();
        this.closePromise = (async () => {
          await Promise.allSettled([this.tail, ...this.publications]);
          await this.cleanOutputs();
        })();
        return this.closePromise;
      }
    };
  }
});

// editor/src/server.mjs
import { spawn as spawn3 } from "node:child_process";
import { randomBytes, randomUUID as randomUUID4 } from "node:crypto";
import { createServer } from "node:http";
import { chmod, open as open3, readFile as readFile4, rename as rename2, rm as rm3, stat as stat3, unlink as unlink2, mkdir as mkdir2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
function serverError(code, message) {
  return new EditorError(code, message);
}
function dataDirOf(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || typeof registry.data_dir !== "string" || registry.data_dir.length === 0) {
    throw serverError("SERVER_OPTIONS_INVALID", "registry.data_dir is required");
  }
  return registry.data_dir;
}
async function readJsonBody(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_REQUEST_BYTES) throw serverError("LIMIT_EXCEEDED", "Request exceeds 1 MiB");
    chunks.push(value);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw serverError("INVALID_REQUEST", "Request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw serverError("INVALID_REQUEST", "Envelope must be an object");
  }
  return parsed;
}
function statusFor(code) {
  if (code === "HOST_FORBIDDEN" || code === "ORIGIN_FORBIDDEN") return 403;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if (code === "UNAUTHORIZED") return 401;
  if (code === "LIMIT_EXCEEDED") return 413;
  if (code === "METHOD_NOT_FOUND") return 404;
  if (code === "SESSION_MISMATCH" || code === "REVISION_STALE" || code === "VIEW_TAKEN") return 409;
  if (code === "SESSION_UNAVAILABLE" || code === "SERVER_CLOSING") return 503;
  return 400;
}
function reply(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store"
  });
  return new Promise((resolve3) => {
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      response.off("close", finish);
      resolve3();
    }
    response.once("close", finish);
    response.end(bytes, finish);
  });
}
function runProcess(command, args) {
  return new Promise((resolve3, reject) => {
    const child = spawn3(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let forcedError;
    const timer = setTimeout(() => {
      forcedError = serverError("REGISTRY_ACL_FAILED", "Private registry ACL command timed out");
      child.kill();
    }, PROCESS_TIMEOUT_MS);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve3(value);
    }
    function collect(chunk, target) {
      bytes += chunk.length;
      if (bytes > MAX_PROCESS_OUTPUT_BYTES && !forcedError) {
        forcedError = serverError("REGISTRY_ACL_FAILED", "Private registry ACL command returned too much output");
        child.kill();
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.once("error", () => finish(serverError("REGISTRY_ACL_FAILED", "Private registry ACL command could not start")));
    child.once("close", (code) => {
      if (forcedError) {
        finish(forcedError);
        return;
      }
      if (code !== 0) {
        finish(serverError("REGISTRY_ACL_FAILED", "Private registry ACL command failed"));
        return;
      }
      finish(null, { stdout, stderr });
    });
  });
}
function sidFromWhoami(output) {
  const fields = output.trim().match(/"(?:[^"]|"")*"/g);
  if (!fields || fields.length < 2) throw serverError("REGISTRY_ACL_FAILED", "Current Windows user SID is unavailable");
  const sid = fields[1].slice(1, -1).replaceAll('""', '"');
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) throw serverError("REGISTRY_ACL_FAILED", "Current Windows user SID is invalid");
  return sid;
}
async function windowsAcl(directory) {
  const script = [
    "& { param([string]$Path)",
    "$acl=Get-Acl -LiteralPath $Path;",
    '$sids=@($acl.Access | Where-Object { $_.AccessControlType -eq "Allow" } | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value });',
    "[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; sids=$sids } | ConvertTo-Json -Compress }"
  ].join(" ");
  const { stdout } = await runProcess(systemTool("powershell"), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    directory
  ]);
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw serverError("REGISTRY_ACL_FAILED", "Private registry ACL verification returned invalid data");
  }
  const sids = Array.isArray(value?.sids) ? value.sids : typeof value?.sids === "string" ? [value.sids] : [];
  if (typeof value?.protected !== "boolean" || sids.some((sid) => typeof sid !== "string")) {
    throw serverError("REGISTRY_ACL_FAILED", "Private registry ACL verification is incomplete");
  }
  return { protected: value.protected, sids };
}
async function ensurePrivateRegistry(directory, aclVerifier = windowsAcl) {
  if (typeof aclVerifier !== "function") throw serverError("REGISTRY_ACL_FAILED", "Private registry ACL verifier is invalid");
  if (process.platform !== "win32") {
    await mkdir2(directory, { recursive: true, mode: 448 });
    await chmod(directory, 448);
    return;
  }
  try {
    await mkdir2(directory, { recursive: true, mode: 448 });
    const { stdout } = await runProcess(systemTool("whoami"), ["/user", "/fo", "csv", "/nh"]);
    const sid = sidFromWhoami(stdout);
    await runProcess(systemTool("icacls"), [
      directory,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F"
    ]);
    const allowed = /* @__PURE__ */ new Set([sid, "S-1-5-18"]);
    let acl = await aclVerifier(directory);
    for (const extra of new Set(acl.sids.filter((value) => !allowed.has(value)))) {
      await runProcess(systemTool("icacls"), [directory, "/remove:g", `*${extra}`]);
      await runProcess(systemTool("icacls"), [directory, "/remove:d", `*${extra}`]);
    }
    acl = await aclVerifier(directory);
    const actual = new Set(acl.sids);
    if (!acl.protected || actual.size !== allowed.size || [...allowed].some((value) => !actual.has(value))) {
      throw serverError("REGISTRY_ACL_FAILED", "Private session registry ACL is not restricted");
    }
  } catch {
    throw serverError("REGISTRY_ACL_FAILED", "Private session registry ACL could not be established");
  }
}
async function atomicRecord(path, record) {
  const pending = `${path}.${randomUUID4()}.pending`;
  const handle = await open3(pending, "wx", 384);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename2(pending, path);
  } finally {
    await rm3(pending, { force: true });
  }
}
async function removeOwnedRecord(path, record) {
  let current;
  let before;
  try {
    before = await stat3(path, { bigint: true });
    current = JSON.parse(await readFile4(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (current.session_id !== record.session_id || current.token !== record.token || current.pid !== record.pid) return;
  const after = await stat3(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) return;
  try {
    await unlink2(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
function cleanupViews(views, now = Date.now()) {
  for (const [id, view] of views) {
    if (view.expires_at <= now) views.delete(id);
  }
}
function viewFor(views, args) {
  const view = views.get(args.view_id);
  if (!view || view.view_generation !== args.view_generation) {
    throw serverError("VIEW_STALE", "View generation is no longer current");
  }
  view.touched = Date.now();
  return view;
}
function focusOf(ui) {
  const focus = typeof ui?.focus === "function" ? ui.focus() : null;
  return { frame_id: focus?.frame_id ?? null, selected_node: focus?.selected_node ?? null };
}
function activeView(views) {
  let best = null;
  for (const view of views.values()) {
    if (!best || view.expires_at > best.expires_at) best = view;
  }
  return best;
}
function createBoard(document, views) {
  let pending = null;
  let resets = 0;
  let closed = false;
  let applying = false;
  return {
    get resets() {
      return resets;
    },
    get pendingId() {
      return pending?.capture_id ?? null;
    },
    get closed() {
      return closed;
    },
    /** The request the given view should answer now, if any. */
    forView(view) {
      const mine = pending && pending.view_id === view.view_id && pending.view_generation === view.view_generation;
      return mine ? { capture_id: pending.capture_id } : null;
    },
    /** Resolves with the outcome once the window's capture was handled; rejects when nothing was applied. */
    request() {
      cleanupViews(views);
      if (closed) return Promise.reject(serverError("SERVER_CLOSING", "The editor is closing, so nothing was applied"));
      if (pending || applying) return Promise.reject(serverError("CAPTURE_BUSY", "The board is already being read"));
      const view = activeView(views);
      if (!view) return Promise.reject(serverError("VIEW_NONE", "No whiteboard is attached to this document"));
      const capture = {
        capture_id: randomUUID4(),
        view_id: view.view_id,
        view_generation: view.view_generation,
        base_revision: document.info().revision,
        expires_at: Date.now() + CAPTURE_TIMEOUT_MS
      };
      return new Promise((resolve3, reject) => {
        capture.resolve = resolve3;
        capture.reject = reject;
        capture.timer = setTimeout(() => {
          if (pending === capture) pending = null;
          reject(serverError("GEOMETRY_CAPTURE_STALE", "The board did not answer in time, so nothing was applied"));
        }, CAPTURE_TIMEOUT_MS);
        capture.timer.unref();
        pending = capture;
      });
    },
    /** The server is closing: the panel's pending request ends now instead of waiting for its timeout. */
    detach(view) {
      const capture = pending;
      if (!capture || capture.view_id !== view.view_id || capture.view_generation !== view.view_generation) return;
      pending = null;
      clearTimeout(capture.timer);
      capture.reject(serverError("VIEW_STALE", "The whiteboard closed before its edits were applied"));
    },
    close() {
      closed = true;
      const capture = pending;
      if (!capture) return;
      pending = null;
      clearTimeout(capture.timer);
      capture.reject(serverError("SERVER_CLOSING", "The editor is closing, so nothing was applied"));
    },
    /** Makes every view rebuild its click targets from the document (the panel's Cancel). */
    reset() {
      resets += 1;
    },
    /** A view that attaches again is a rebuilt board: a request made for its old generation can no longer be answered. */
    viewReplaced(view) {
      const capture = pending;
      if (!capture || capture.view_id !== view.view_id || capture.view_generation === view.view_generation) return;
      pending = null;
      clearTimeout(capture.timer);
      capture.reject(serverError("GEOMETRY_CAPTURE_STALE", "The board was rebuilt while it was read, so nothing was applied"));
    },
    /** Takes the pending request once, for exactly the capture id and view it was made for. */
    claim(view, args) {
      const capture = pending;
      if (!capture || capture.capture_id !== args.capture_id || capture.view_id !== view.view_id || capture.view_generation !== view.view_generation || Date.now() > capture.expires_at) {
        throw serverError("GEOMETRY_CAPTURE_STALE", "Geometry capture is stale or expired");
      }
      pending = null;
      applying = true;
      clearTimeout(capture.timer);
      return capture;
    },
    /**
     * The capture of a gesture the window found ended on its own board: no request of the panel is needed, but only the
     * view that holds the lease may make one, and never while another capture is pending or being applied.
     */
    claimDirect(view, args) {
      if (closed) throw serverError("SERVER_CLOSING", "The editor is closing, so nothing was applied");
      if (view.holder === void 0 || pending || applying) {
        throw serverError("GEOMETRY_CAPTURE_STALE", "The board cannot be captured now");
      }
      applying = true;
      return { capture_id: args.capture_id, view_id: view.view_id, view_generation: view.view_generation, base_revision: document.info().revision, resolve() {
      }, reject() {
      } };
    },
    /** The claimed capture was answered. */
    settled() {
      applying = false;
    }
  };
}
function boundedEnvelope(envelope) {
  while (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_METADATA_BYTES) {
    if (envelope.page.nodes.length <= 1) throw serverError("LIMIT_EXCEEDED", "One metadata node exceeds 32 KiB");
    envelope.page.nodes.pop();
    envelope.page.next_cursor = envelope.page.cursor + envelope.page.nodes.length;
  }
  validateMetadataPage(envelope.page);
  return envelope;
}
function createDispatcher(document, renderer, ui, mcp, onClose) {
  let windowAsked = Date.now();
  let closeAsked = false;
  const window = { idle_ms: () => Date.now() - windowAsked, renew: () => {
    windowAsked = Date.now();
  } };
  const views = /* @__PURE__ */ new Map();
  const detached = /* @__PURE__ */ new Map();
  function checkViewSlot(id) {
    cleanupViews(views);
    cleanupViews(detached);
    if (!views.has(id) && !detached.has(id) && (/* @__PURE__ */ new Set([...views.keys(), ...detached.keys()])).size >= MAX_VIEWS) {
      throw serverError("LIMIT_EXCEEDED", "Too many active views");
    }
  }
  const board = createBoard(document, views);
  const activity = (shownRevision) => {
    const info = document.info();
    const render = renderer.status();
    if (shownRevision !== void 0) render.rendered_revision = shownRevision;
    const state = activityState(info, render);
    let affected = state === "ready" ? render.exported_frame_ids ?? [] : state === "working" && info.phase === "ready" && render.refreshing_revision === info.revision ? render.affected_frame_ids ?? null : null;
    if (affected && (affected.length > 64 || Buffer.byteLength(JSON.stringify(affected), "utf8") > 4096)) affected = null;
    return {
      state,
      phase: info.phase,
      revision: info.revision,
      rendered_revision: render.rendered_revision,
      dirty: info.dirty,
      affected_frame_ids: affected
    };
  };
  const viewState = (view, shownRevision) => ({ capture: board.forView(view), reset: board.resets, activity: activity(shownRevision) });
  let attemptedRevision = null;
  function requestRefresh() {
    const info = document.info();
    if (info.phase !== "ready" || attemptedRevision === info.revision) return;
    attemptedRevision = info.revision;
    void renderer.refresh(info.revision).catch(() => void 0);
  }
  let changes = 0;
  let lastSignature = "";
  function changeSeq() {
    const info = document.info();
    const render = renderer.status();
    const signature = JSON.stringify([
      info.revision,
      info.phase,
      info.dirty,
      info.status_seq,
      render.rendered_revision,
      render.refreshing_revision,
      render.affected_frame_ids,
      render.error?.code,
      focusOf(ui),
      board.resets,
      board.pendingId,
      board.closed
    ]);
    if (signature !== lastSignature) {
      lastSignature = signature;
      changes += 1;
    }
    return changes;
  }
  async function holdForChange(since, waitMs) {
    const deadline = Date.now() + Math.min(waitMs, MAX_HOLD_MS);
    while (!board.closed && changeSeq() <= since && Date.now() < deadline) {
      await new Promise((resolve3) => setTimeout(resolve3, HOLD_STEP_MS));
    }
  }
  async function applyCapture(view, capture, args) {
    const base = capture.base_revision;
    const current = () => !board.closed && views.get(view.view_id) === view && document.info().revision === base && args.scene_revision === base && view.scene_revision === base;
    const conflict = () => serverError("REVISION_STALE", "The document changed after the board was read, so nothing was applied");
    if (!current()) throw conflict();
    const model = await document.readModel();
    if (!current()) throw conflict();
    const operations = geometryChanges({
      model,
      view: { view_id: view.view_id, view_generation: view.view_generation, scene_revision: view.scene_revision },
      capture: args
    });
    const reconcile = args.needs_reconcile === true;
    if (operations.length === 0) return { applied: false, changes: 0, revision: base, reconcile };
    const result = await document.applyChanges({ session_id: document.info().session_id, base_revision: base, operations }, current);
    return { applied: result.revision !== base, changes: operations.length, revision: result.revision, reconcile };
  }
  async function dispatch(method, args) {
    if (board.closed) throw serverError("SERVER_CLOSING", "The editor is closing");
    if (VIEW_METHODS.includes(method)) window.renew();
    const info = document.info();
    switch (method) {
      // The window's own read of the same answer: a view method, so it keeps the owner (an agent's get_document does not).
      case "poll_document":
      case "get_document": {
        const render = renderer.status();
        return {
          ...info,
          frames: render.frame_ids,
          recovery_choices: recoveryChoices(info),
          activity: activity(),
          render: {
            rendered_revision: render.rendered_revision,
            refreshing_revision: render.refreshing_revision,
            error: render.error ? { code: "RENDER_FAILED", message: "Official frame rendering failed" } : null
          },
          limits: { operations: 100, request_bytes: MAX_REQUEST_BYTES, metadata_nodes: 64, metadata_bytes: MAX_METADATA_BYTES },
          capabilities: { structured_operations: true, explicit_save: true, document_history: true }
        };
      }
      case "get_nodes": {
        const nodes = await document.withEngine(info.revision, async (engine) => {
          const values = [];
          for (const path of args.paths) {
            const value = await readNode(engine, path);
            if (value === null) {
              values.push({ path, node: null, bounds: null });
            } else {
              const { bounds, ...node } = value;
              values.push({ path, node, bounds: bounds ?? null });
            }
          }
          return values;
        });
        const page = { nodes };
        validateMetadataPage(page);
        return page;
      }
      case "get_variables":
        return document.withEngine(info.revision, readVariables);
      case "get_schema":
        return {
          schema: await document.withEngine(info.revision, (engine) => engine.schema()),
          operations: ["insert", "copy", "update", "replace", "move", "delete", "set_variables"]
        };
      case "apply_changes":
        return document.applyChanges(args);
      case "get_frame_image": {
        await renderer.refresh(info.revision);
        const image = await renderer.frameImage({
          frame_id: args.frame_id,
          revision: info.revision,
          max_side: args.max_side ?? 4096
        });
        const bytes = await readFile4(image.path);
        if (document.info().revision !== image.revision) throw serverError("RENDER_NOT_CURRENT", "Image revision is no longer current");
        const { path, ...metadata } = image;
        return { kind: "image", metadata, base64: bytes.toString("base64") };
      }
      case "undo_document":
        return document.undo(args);
      case "redo_document":
        return document.redo(args);
      case "save_document":
        return document.saveOriginal(args);
      case "get_mcp_config":
        if (!mcp) throw serverError("METHOD_NOT_FOUND", "Method is not supported");
        return { mcp };
      case "close_editor":
        if (typeof onClose !== "function") throw serverError("METHOD_NOT_FOUND", "Method is not supported");
        if (!closeAsked) {
          closeAsked = true;
          setImmediate(onClose);
        }
        return { closing: true };
      case "discard_unsaved":
        return document.discardUnsaved(args);
      case "resolve_recovery":
        return document.resolveRecovery(args.choice);
      case "save_recovery_copy":
        return document.saveRecoveryCopy(args);
      case "attach_view": {
        checkViewSlot(args.view_id);
        const now = Date.now();
        if (args.holder !== void 0) {
          for (const other of [...views.values()]) {
            if (other.holder === void 0 || other.holder === args.holder) continue;
            if (now - other.touched < VIEW_LEASE_MS) throw serverError("VIEW_TAKEN", "Another window is showing this document");
            board.detach(other);
            views.delete(other.view_id);
            detached.delete(other.view_id);
          }
          if (detached.get(args.view_id)?.holder !== args.holder) detached.delete(args.view_id);
        }
        const previous = views.get(args.view_id);
        if (previous && previous.view_generation > args.view_generation || (detached.get(args.view_id)?.view_generation ?? -1) >= args.view_generation) {
          throw serverError("VIEW_STALE", "View generation is no longer current");
        }
        const frameId = args.frame_id ?? renderer.status().frame_ids[0] ?? "";
        const view = {
          view_id: args.view_id,
          view_generation: args.view_generation,
          scene_revision: args.scene_revision,
          frame_id: frameId,
          selected_node: null,
          expires_at: now + VIEW_TIMEOUT_MS,
          holder: args.holder,
          touched: now
        };
        views.set(args.view_id, view);
        board.viewReplaced(view);
        return { ...view, request_id: args.request_id, status_seq: info.status_seq, focus: focusOf(ui), ...viewState(view) };
      }
      case "detach_view": {
        checkViewSlot(args.view_id);
        const view = views.get(args.view_id);
        if (view && view.view_generation > args.view_generation) throw serverError("VIEW_STALE", "View generation is no longer current");
        detached.set(args.view_id, {
          holder: view?.holder ?? detached.get(args.view_id)?.holder,
          view_generation: Math.max(args.view_generation, detached.get(args.view_id)?.view_generation ?? -1),
          expires_at: Date.now() + VIEW_TIMEOUT_MS + REQUEST_TIMEOUT_MS
        });
        if (view?.view_generation === args.view_generation) {
          views.delete(args.view_id);
          board.detach(view);
        }
        return { request_id: args.request_id, view_generation: args.view_generation, detached: true };
      }
      case "poll_view": {
        cleanupViews(views);
        const view = viewFor(views, args);
        const frameId = args.frame_id ?? view.frame_id;
        const requestId = args.request_id;
        const generation = view.view_generation;
        const expiresAt = Date.now() + VIEW_TIMEOUT_MS;
        const revision = document.info().revision;
        await renderer.refresh(revision);
        if (views.get(args.view_id) !== view || view.view_generation !== generation) {
          throw serverError("VIEW_STALE", "View generation changed during polling");
        }
        const page = renderer.projection({ frame_id: frameId, cursor: args.cursor ?? null });
        view.frame_id = frameId;
        view.expires_at = expiresAt;
        view.scene_revision = page.revision;
        return boundedEnvelope({
          request_id: requestId,
          status_seq: document.info().status_seq,
          view_generation: generation,
          page,
          focus: focusOf(ui),
          ...viewState(view, page.revision)
        });
      }
      case "list_frames": {
        cleanupViews(views);
        const view = viewFor(views, args);
        const generation = view.view_generation;
        if (args.wait_ms > 0) await holdForChange(args.since ?? 0, args.wait_ms);
        const seq = changeSeq();
        requestRefresh();
        if (views.get(args.view_id) !== view || view.view_generation !== generation) {
          throw serverError("VIEW_STALE", "View generation changed during listing");
        }
        const rendered = renderer.status();
        const page = rendered.rendered_revision === null ? { frame_id: view.frame_id, revision: 0, nodes: [], cursor: 0, next_cursor: null } : await renderer.frameList({ frame_id: view.frame_id, cursor: args.cursor ?? null });
        if (board.closed || views.get(args.view_id) !== view) throw serverError("VIEW_STALE", "View changed during publication");
        view.expires_at = Date.now() + VIEW_TIMEOUT_MS;
        return boundedEnvelope({
          request_id: args.request_id,
          status_seq: document.info().status_seq,
          view_generation: generation,
          page,
          focus: focusOf(ui),
          ...viewState(view, rendered.rendered_revision === null ? null : page.revision),
          change_seq: seq
        });
      }
      case "select_node": {
        const view = viewFor(views, args);
        if (view.scene_revision !== args.scene_revision) throw serverError("VIEW_STALE", "View revision is no longer current");
        view.selected_node = args.path;
        if (typeof ui?.selectNode === "function") await ui.selectNode({ ...view, path: args.path });
        return { request_id: args.request_id, path: args.path, view_generation: view.view_generation };
      }
      case "submit_capture": {
        const view = viewFor(views, args);
        const capture = args.direct === true ? board.claimDirect(view, args) : board.claim(view, args);
        const answer = { request_id: args.request_id, capture_id: capture.capture_id, view_generation: view.view_generation };
        try {
          const outcome = await applyCapture(view, capture, args);
          capture.resolve(outcome);
          return { ...answer, outcome: outcome.applied ? "applied" : "unchanged", revision: outcome.revision, reconcile: outcome.reconcile };
        } catch (error) {
          capture.reject(error);
          const { code } = publicError(error);
          if (code === "REVISION_STALE") return { ...answer, outcome: "conflict", code };
          if (code.startsWith("GEOMETRY_")) {
            const layout = code === "GEOMETRY_CONTROLLED_BY_LAYOUT" ? error.details?.layout : void 0;
            const current = code === "GEOMETRY_TEXT_CONFLICT" ? error.details?.current : void 0;
            return { ...answer, outcome: "refused", code, ...typeof layout === "string" ? { layout } : {}, ...typeof current === "string" ? { current } : {} };
          }
          throw error;
        } finally {
          board.settled();
        }
      }
    }
    throw serverError("METHOD_NOT_FOUND", "Method is not supported");
  }
  return { dispatch, board, window };
}
async function startServer({ document, renderer, registry, ui, mcp, onClose, aclVerifier }) {
  if (!document || typeof document.info !== "function" || !renderer || typeof renderer.status !== "function") {
    throw serverError("SERVER_OPTIONS_INVALID", "document and renderer are required");
  }
  const dataDir = dataDirOf(registry);
  const session = document.info();
  const recordPath = sessionRecordPath(dataDir, session.original_path);
  await ensurePrivateRegistry(dirname2(recordPath), aclVerifier);
  const token = randomBytes(32).toString("base64url");
  let closing = false;
  let expectedHost;
  const sockets = /* @__PURE__ */ new Set();
  const handlers = /* @__PURE__ */ new Set();
  const headerTimers = /* @__PURE__ */ new Map();
  const { dispatch, board, window } = createDispatcher(document, renderer, ui, mcp, onClose);
  function headerValues(request, name) {
    const values = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
    }
    return values;
  }
  function clearHeaderTimer(socket) {
    const timer = headerTimers.get(socket);
    if (timer) clearTimeout(timer);
    headerTimers.delete(socket);
  }
  async function handleRequest(request, response) {
    clearHeaderTimer(request.socket);
    try {
      const hosts = headerValues(request, "host");
      if (hosts.length !== 1 || hosts[0] !== expectedHost) throw serverError("HOST_FORBIDDEN", "Host is forbidden");
      if (headerValues(request, "origin").length !== 0) throw serverError("ORIGIN_FORBIDDEN", "Origin is forbidden");
      if (closing) throw serverError("SERVER_CLOSING", "Server is closing");
      if (request.method !== "POST" || request.url !== "/") throw serverError("METHOD_NOT_ALLOWED", "HTTP method is not allowed");
      authorize(request.headers.authorization, token, true);
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw serverError("LIMIT_EXCEEDED", "Request exceeds 1 MiB");
      const envelope = await readJsonBody(request);
      const keys = Object.keys(envelope);
      if (keys.some((key) => !["method", "args", "session_id"].includes(key)) || typeof envelope.method !== "string") {
        throw serverError("INVALID_REQUEST", "Envelope contains unsupported fields");
      }
      validateCall(envelope.method, envelope.args, Buffer.byteLength(JSON.stringify(envelope), "utf8"));
      if (envelope.session_id !== session.session_id || document.info().session_id !== session.session_id) {
        throw serverError("SESSION_MISMATCH", "Request belongs to another document session");
      }
      const result = await dispatch(envelope.method, envelope.args);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESPONSE_BYTES) throw serverError("LIMIT_EXCEEDED", "Response exceeds its limit");
      await reply(response, 200, { result });
    } catch (error) {
      const value = error?.code === "SERVER_CLOSING" ? { code: "SERVER_CLOSING", message: "Server is closing" } : publicError(error, token);
      await reply(response, statusFor(value.code), { error: value });
    }
  }
  const listener = createServer({
    maxHeaderSize: MAX_HEADER_BYTES,
    joinDuplicateHeaders: true,
    requireHostHeader: false
  }, (request, response) => {
    const handler = handleRequest(request, response);
    handlers.add(handler);
    void handler.then(
      () => handlers.delete(handler),
      () => handlers.delete(handler)
    );
  });
  listener.headersTimeout = HEADERS_TIMEOUT_MS;
  listener.requestTimeout = REQUEST_TIMEOUT_MS;
  listener.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  listener.maxConnections = MAX_CONNECTIONS;
  listener.on("connection", (socket) => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), HEADERS_TIMEOUT_MS);
    headerTimers.set(socket, timer);
    socket.once("close", () => {
      clearHeaderTimer(socket);
      sockets.delete(socket);
    });
  });
  listener.on("clientError", (_error, socket) => socket.destroy());
  async function drainHandlers() {
    let timer;
    const timeout = new Promise((resolve3) => {
      timer = setTimeout(() => resolve3(false), DRAIN_TIMEOUT_MS);
    });
    try {
      while (handlers.size > 0) {
        const drained = await Promise.race([
          Promise.allSettled([...handlers]).then(() => true),
          timeout
        ]);
        if (!drained) return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
  async function stopListener() {
    closing = true;
    let closed = Promise.resolve();
    if (listener.listening) closed = new Promise((resolve3) => listener.close(() => resolve3()));
    const drained = await drainHandlers();
    const aborted = drained ? 0 : handlers.size;
    listener.closeIdleConnections();
    listener.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((resolve3) => {
          timer = setTimeout(resolve3, SOCKET_CLOSE_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { drained, aborted };
  }
  try {
    await new Promise((resolve3, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve3();
      });
    });
  } catch (error) {
    await stopListener();
    throw error;
  }
  const address = listener.address();
  expectedHost = `127.0.0.1:${address.port}`;
  const endpoint = `http://${expectedHost}`;
  const record = {
    version: 1,
    original_path: session.original_path,
    endpoint,
    token,
    session_id: session.session_id,
    pid: process.pid
  };
  if (typeof registry.launch_id === "string" && /^[0-9a-f]{32}$/.test(registry.launch_id)) record.launch_id = registry.launch_id;
  try {
    await atomicRecord(recordPath, record);
  } catch (error) {
    await stopListener();
    throw error;
  }
  let closePromise;
  return {
    endpoint,
    token,
    board,
    window,
    close() {
      if (closePromise) return closePromise;
      board.close();
      closing = true;
      listener.closeIdleConnections();
      closePromise = (async () => {
        let removal;
        try {
          await removeOwnedRecord(recordPath, record);
        } catch (error) {
          removal = { error };
        }
        const result = await stopListener();
        if (removal) throw removal.error;
        return result;
      })();
      return closePromise;
    }
  };
}
var VIEW_TIMEOUT_MS, CAPTURE_TIMEOUT_MS, MAX_HOLD_MS, HOLD_STEP_MS, MAX_VIEWS, VIEW_LEASE_MS, MAX_RESPONSE_BYTES, MAX_HEADER_BYTES, MAX_CONNECTIONS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, DRAIN_TIMEOUT_MS, SOCKET_CLOSE_TIMEOUT_MS, PROCESS_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES;
var init_server = __esm({
  "editor/src/server.mjs"() {
    init_geometry();
    init_model();
    init_protocol();
    init_errors();
    init_panel_model();
    init_system();
    VIEW_TIMEOUT_MS = 12e4;
    CAPTURE_TIMEOUT_MS = 2e4;
    MAX_HOLD_MS = 2e3;
    HOLD_STEP_MS = 50;
    MAX_VIEWS = 16;
    VIEW_LEASE_MS = 1e4;
    MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
    MAX_HEADER_BYTES = 16 * 1024;
    MAX_CONNECTIONS = 32;
    HEADERS_TIMEOUT_MS = 1e4;
    REQUEST_TIMEOUT_MS = 3e4;
    KEEP_ALIVE_TIMEOUT_MS = 5e3;
    DRAIN_TIMEOUT_MS = 15e3;
    SOCKET_CLOSE_TIMEOUT_MS = 500;
    PROCESS_TIMEOUT_MS = 1e4;
    MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
  }
});

// editor/src/liveness.mjs
import { readFile as readFile5, stat as stat4 } from "node:fs/promises";
import { connect } from "node:net";
function pidStatus(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    return error?.code === "ESRCH" ? "missing" : "unknown";
  }
}
function endpointRefuses(endpoint) {
  let port;
  try {
    port = Number(new URL(endpoint).port);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve3) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (refused) => {
      socket.destroy();
      resolve3(refused);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", (error) => done(error?.code === "ECONNREFUSED"));
  });
}
async function publishedEndpoint(dataDir, originalPath, sessionId) {
  try {
    const path = sessionRecordPath(dataDir, originalPath);
    if ((await stat4(path)).size > MAX_RECORD_BYTES) return void 0;
    const record = JSON.parse(await readFile5(path, "utf8"));
    return record?.session_id === sessionId && typeof record.endpoint === "string" ? record.endpoint : void 0;
  } catch {
    return void 0;
  }
}
async function lockOwnerStatus(lock, dataDir, { probe = endpointRefuses } = {}) {
  const status = pidStatus(lock.pid);
  if (status === "missing") return status;
  const endpoint = await publishedEndpoint(dataDir, lock.original_path, lock.session_id);
  if (endpoint === void 0 || !await probe(endpoint)) return status;
  return await publishedEndpoint(dataDir, lock.original_path, lock.session_id) === endpoint ? "missing" : status;
}
var MAX_RECORD_BYTES, PROBE_TIMEOUT_MS;
var init_liveness = __esm({
  "editor/src/liveness.mjs"() {
    init_protocol();
    MAX_RECORD_BYTES = 64 * 1024;
    PROBE_TIMEOUT_MS = 1e3;
  }
});

// editor/src/source.mjs
import { createHash as createHash4, randomUUID as randomUUID5 } from "node:crypto";
import { link, lstat as lstat2, mkdir as mkdir3, readFile as readFile6, readdir, realpath, rename as rename3, rm as rm4, unlink as unlink3, writeFile } from "node:fs/promises";
import { basename as basename2, dirname as dirname3, join as join5 } from "node:path";
function sha2562(bytes) {
  return createHash4("sha256").update(bytes).digest("hex");
}
function sourceError(code, message, details2) {
  return new EditorError(code, message, details2);
}
async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    throw sourceError("SOURCE_UNAVAILABLE", "The original file cannot be opened", { cause: error });
  }
}
async function readOriginal(path) {
  try {
    return await readFile6(path);
  } catch (error) {
    throw sourceError("SOURCE_UNAVAILABLE", "The original file cannot be read", { cause: error });
  }
}
function lockPath(dataDir, originalPath) {
  const sourceId = sha2562(Buffer.from(originalPath));
  return join5(dataDir, "sources", `${sourceId}.json`);
}
function workingPath(originalPath) {
  return join5(
    dirname3(originalPath),
    `.${basename2(originalPath)}.tern-pencil-${randomUUID5()}.pen`
  );
}
async function readLockRecord(path) {
  try {
    return JSON.parse(await readFile6(path, "utf8"));
  } catch {
    throw sourceError("ALREADY_OPEN", "The source lock cannot be verified");
  }
}
async function existingLockError(path, dataDir) {
  const record = await readLockRecord(path);
  if (await lockOwnerStatus(record, dataDir) === "missing") {
    throw sourceError("RECOVERY_REQUIRED", "A previous source session needs recovery", { recovery: record });
  }
  throw sourceError("ALREADY_OPEN", "The source is already open", {
    session_id: record.session_id,
    pid: record.pid
  });
}
async function createLock(path, record, dataDir) {
  try {
    await writeFile(path, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 384 });
  } catch (error) {
    if (error?.code === "EEXIST") await existingLockError(path, dataDir);
    throw sourceError("LOCK_UNAVAILABLE", "The source lock cannot be created", { cause: error });
  }
}
async function captureLock(path) {
  const tombstone = `${path}.${randomUUID5()}.adopting`;
  try {
    await rename3(path, tombstone);
    return tombstone;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw sourceError("ALREADY_OPEN", "The source lock changed before adoption");
    }
    throw sourceError("LOCK_UNAVAILABLE", "The source lock cannot be captured for adoption", { cause: error });
  }
}
async function restoreCapturedLock(tombstone, path) {
  try {
    await link(tombstone, path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw sourceError("ALREADY_OPEN", "The source lock changed during adoption");
    }
    if (error?.code === "EEXIST") {
      throw sourceError("ALREADY_OPEN", "Another source lock appeared during adoption", {
        tombstone_path: tombstone
      });
    }
    throw sourceError("LOCK_UNAVAILABLE", "The captured source lock cannot be restored", {
      cause: error,
      tombstone_path: tombstone
    });
  }
  try {
    await unlink3(tombstone);
  } catch (error) {
    throw sourceError("LOCK_UNAVAILABLE", "The restored source lock tombstone cannot be removed", {
      cause: error,
      tombstone_path: tombstone
    });
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function workingNamePattern(canonical, flags = "i") {
  return new RegExp(`^\\.${escapeRegExp(basename2(canonical))}\\.tern-pencil-${UUID_V4}\\.pen$`, flags);
}
async function sweepStaleCopies(canonical, keep) {
  const directory = dirname3(canonical);
  const pattern = workingNamePattern(canonical, "");
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join5(directory, name);
    if (path === keep || !pattern.test(name)) continue;
    try {
      if ((await lstat2(path)).isFile()) await rm4(path, { force: true });
    } catch {
    }
  }
}
function isLockRecord(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record) && typeof record.original_path === "string" && typeof record.owner === "string" && typeof record.session_id === "string" && record.owner === record.session_id && Number.isInteger(record.pid) && record.pid > 0 && typeof record.working_path === "string" && record.working_path.length > 0;
}
async function validateOrphanRecord(record, canonical, orphanSessionId, dataDir) {
  if (!isLockRecord(record)) {
    throw sourceError("SOURCE_LOCK_INVALID", "The orphan source lock is incomplete");
  }
  if (record.session_id !== orphanSessionId || await lockOwnerStatus(record, dataDir) !== "missing") {
    throw sourceError("ALREADY_OPEN", "The source lock cannot be adopted");
  }
  if (record.original_path !== canonical) {
    throw sourceError("SOURCE_LOCK_INVALID", "The orphan source lock belongs to another original");
  }
  let originalDir;
  let workingDir;
  try {
    [originalDir, workingDir] = await Promise.all([
      realpath(dirname3(canonical)),
      realpath(dirname3(record.working_path))
    ]);
  } catch (error) {
    throw sourceError("SOURCE_LOCK_INVALID", "The orphan working directory cannot be verified", { cause: error });
  }
  if (workingDir !== originalDir) {
    throw sourceError("SOURCE_LOCK_INVALID", "The orphan working file is outside the original directory");
  }
  const expectedName = workingNamePattern(canonical);
  if (!expectedName.test(basename2(record.working_path))) {
    throw sourceError("SOURCE_LOCK_INVALID", "The orphan working file name is invalid");
  }
  let details2;
  try {
    details2 = await lstat2(record.working_path);
  } catch (error) {
    if (error?.code === "ENOENT") return record;
    throw sourceError("SOURCE_LOCK_INVALID", "The orphan working file cannot be inspected", { cause: error });
  }
  if (details2.isSymbolicLink() || !details2.isFile()) {
    throw sourceError("SOURCE_LOCK_INVALID", "The orphan working path is not a regular file");
  }
  return record;
}
async function createAdoptedLock(path, record, tombstone) {
  try {
    await writeFile(path, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 384 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw sourceError("ALREADY_OPEN", "The source lock changed during adoption", {
        tombstone_path: tombstone
      });
    }
    throw sourceError("LOCK_UNAVAILABLE", "The adopted source lock cannot be created", { cause: error });
  }
}
async function unlinkIfExists2(path) {
  try {
    await unlink3(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
async function rejectCapturedLock(tombstone, path, error) {
  await restoreCapturedLock(tombstone, path);
  throw error;
}
async function rollbackAdoption(path, tombstone, record, ownership, cause) {
  try {
    await releaseLock(path, record.session_id, record.original_path);
    ownership.claimed = false;
  } catch (releaseError) {
    throw sourceError("LOCK_UNAVAILABLE", "The failed adopted lock cannot be released", {
      cause,
      release: releaseError,
      tombstone_path: tombstone
    });
  }
  try {
    await restoreCapturedLock(tombstone, path);
  } catch (restoreError) {
    throw sourceError("LOCK_UNAVAILABLE", "The orphan lock cannot be restored after failed adoption", {
      cause,
      restore: restoreError,
      tombstone_path: tombstone
    });
  }
  throw cause;
}
async function adoptOrphanLock(path, canonical, orphanSessionId, record, ownership, dataDir) {
  const tombstone = await captureLock(path);
  let orphan;
  try {
    orphan = await readLockRecord(tombstone);
    await validateOrphanRecord(orphan, canonical, orphanSessionId, dataDir);
  } catch (error) {
    return rejectCapturedLock(tombstone, path, error);
  }
  try {
    await createAdoptedLock(path, record, tombstone);
  } catch (error) {
    if (error?.code !== "ALREADY_OPEN") {
      return rejectCapturedLock(tombstone, path, error);
    }
    throw error;
  }
  ownership.claimed = true;
  try {
    await unlinkIfExists2(orphan.working_path);
  } catch (error) {
    return rollbackAdoption(path, tombstone, record, ownership, error);
  }
  try {
    await unlink3(tombstone);
    return void 0;
  } catch {
    return Object.freeze([tombstone]);
  }
}
async function removeSessionTombstones(path, sessionId, originalPath) {
  const directory = dirname3(path);
  const pattern = new RegExp(`^${escapeRegExp(basename2(path))}\\.${UUID_V4}\\.adopting$`, "i");
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  let removalError;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const tombstone = join5(directory, name);
    let details2;
    try {
      details2 = await lstat2(tombstone);
    } catch {
      continue;
    }
    if (details2.isSymbolicLink() || !details2.isFile() || details2.size > MAX_LOCK_BYTES) continue;
    let record;
    try {
      record = JSON.parse(await readFile6(tombstone, "utf8"));
    } catch {
      continue;
    }
    if (!isLockRecord(record) || record.session_id !== sessionId || record.original_path !== originalPath) continue;
    try {
      await unlink3(tombstone);
    } catch (error) {
      if (error?.code !== "ENOENT" && !removalError) removalError = error;
    }
  }
  if (removalError) throw removalError;
}
async function releaseLock(path, sessionId, originalPath) {
  try {
    let record;
    try {
      record = JSON.parse(await readFile6(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (record.session_id !== sessionId) return;
    try {
      await unlink3(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } finally {
    await removeSessionTombstones(path, sessionId, originalPath);
  }
}
async function createWorkingCopy(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 384 });
    return path;
  } catch (error) {
    throw sourceError("WORKING_COPY_FAILED", "A safe working copy cannot be created", { cause: error });
  }
}
async function verifyWorkingCopy(path, fingerprint) {
  let bytes;
  try {
    bytes = await readFile6(path);
  } catch (error) {
    throw sourceError("SOURCE_CHANGED", "The working copy cannot be verified", { cause: error });
  }
  if (sha2562(bytes) !== fingerprint) {
    throw sourceError("SOURCE_CHANGED", "The working copy changed while it was written");
  }
}
async function claimSource({ original_path: originalPath, data_dir: dataDir, session_id: sessionId, adopt_orphan: adoptOrphan }) {
  if (adoptOrphan !== void 0 && typeof adoptOrphan !== "string") {
    throw sourceError("SOURCE_OPTIONS_INVALID", "adopt_orphan must be a session id");
  }
  const canonical = await canonicalPath(originalPath);
  const registryDir = join5(dataDir, "sources");
  try {
    await mkdir3(registryDir, { recursive: true, mode: 448 });
  } catch (error) {
    throw sourceError("LOCK_UNAVAILABLE", "The private source registry cannot be created", { cause: error });
  }
  const lock = lockPath(dataDir, canonical);
  const nextWorkingPath = workingPath(canonical);
  const record = {
    original_path: canonical,
    owner: sessionId,
    pid: process.pid,
    session_id: sessionId,
    working_path: nextWorkingPath
  };
  const ownership = { claimed: false };
  let adoptionLeftovers;
  let releasePromise;
  function release() {
    if (releasePromise) return releasePromise;
    releasePromise = releaseLock(lock, sessionId, canonical).catch((error) => {
      releasePromise = void 0;
      throw error;
    });
    return releasePromise;
  }
  try {
    if (adoptOrphan === void 0) {
      await createLock(lock, record, dataDir);
      ownership.claimed = true;
    } else {
      adoptionLeftovers = await adoptOrphanLock(lock, canonical, adoptOrphan, record, ownership, dataDir);
    }
    const bytes = await readOriginal(canonical);
    let fingerprint = sha2562(bytes);
    await createWorkingCopy(nextWorkingPath, bytes);
    await verifyWorkingCopy(nextWorkingPath, fingerprint);
    if (sha2562(await readOriginal(canonical)) !== fingerprint) {
      throw sourceError("SOURCE_CHANGED", "The original changed while the working copy was captured");
    }
    await sweepStaleCopies(canonical, nextWorkingPath);
    const claimed = {
      working_path: nextWorkingPath,
      async assertDiskBase() {
        let current;
        try {
          current = sha2562(await readOriginal(canonical));
        } catch (error) {
          throw sourceError("SOURCE_CHANGED", "The original is no longer available", { cause: error });
        }
        if (current !== fingerprint) {
          throw sourceError("SOURCE_CHANGED", "The original changed outside this session");
        }
      },
      async acceptPublished(hash) {
        if (!/^[a-f0-9]{64}$/.test(hash)) {
          throw sourceError("SOURCE_FINGERPRINT_INVALID", "Published source fingerprint is invalid");
        }
        let current;
        try {
          current = sha2562(await readOriginal(canonical));
        } catch (error) {
          throw sourceError("SOURCE_CHANGED", "The published original is no longer available", { cause: error });
        }
        if (current !== hash) {
          throw sourceError("SOURCE_CHANGED", "The published original changed before confirmation");
        }
        fingerprint = hash;
      },
      async restore(bytes2) {
        await writeFile(nextWorkingPath, bytes2);
        await verifyWorkingCopy(nextWorkingPath, sha2562(bytes2));
      },
      /** Removes this session's own working copy; the confirmed state lives in the history store. */
      async discardWorking() {
        await rm4(nextWorkingPath, { force: true, maxRetries: 5, retryDelay: 100 });
      },
      release
    };
    Object.defineProperties(claimed, {
      original_path: { value: canonical, enumerable: true },
      session_id: { value: sessionId, enumerable: true },
      source_fingerprint: { get: () => fingerprint, enumerable: true },
      adopted_orphan: { value: adoptOrphan !== void 0, enumerable: true }
    });
    if (adoptionLeftovers) {
      Object.defineProperty(claimed, "adoption_leftovers", {
        value: adoptionLeftovers,
        enumerable: true
      });
    }
    return claimed;
  } catch (error) {
    try {
      await rm4(nextWorkingPath, { force: true });
    } finally {
      if (ownership.claimed) await release();
    }
    throw error;
  }
}
var UUID_V4, MAX_LOCK_BYTES;
var init_source = __esm({
  "editor/src/source.mjs"() {
    init_errors();
    init_liveness();
    UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    MAX_LOCK_BYTES = 64 * 1024;
  }
});

// editor/src/store.mjs
import { createHash as createHash5, randomUUID as randomUUID6 } from "node:crypto";
import { link as link2, mkdir as mkdir4, open as open4, readFile as readFile7, rename as rename4, stat as stat5, unlink as unlink4 } from "node:fs/promises";
import { join as join6 } from "node:path";
function sha2563(bytes) {
  return createHash5("sha256").update(bytes).digest("hex");
}
function isObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function copyIndex2(index) {
  return {
    ...index,
    source: { ...index.source },
    snapshots: [...index.snapshots],
    sizes: { ...index.sizes }
  };
}
function assertCheckpointId(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new EditorError("CHECKPOINT_INVALID", "Checkpoint id is invalid");
  }
}
async function writeDurable(path, data) {
  const handle = await open4(path, "wx", 384);
  try {
    await handle.writeFile(data);
    await handle.sync();
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}
async function unlinkIfExists3(path) {
  try {
    await unlink4(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
function validateIndex(value) {
  if (!isObject2(value) || value.version !== 1 || !isObject2(value.source) || typeof value.source.fingerprint !== "string" || value.source.fingerprint.length === 0 || !Array.isArray(value.snapshots) || typeof value.saved_id !== "string" || !Number.isSafeInteger(value.cursor) || !Number.isSafeInteger(value.revision) || !isObject2(value.sizes)) {
    throw new EditorError("INDEX_INVALID", "History index is incomplete");
  }
  if (value.revision < 0 || value.cursor < 0 || value.cursor >= value.snapshots.length || value.snapshots.some((id) => typeof id !== "string")) {
    throw new EditorError("INDEX_INVALID", "History index has invalid history entries");
  }
  for (const id of retainedIds(
    /** @type {HistoryIndex} */
    value
  )) {
    try {
      assertCheckpointId(id);
    } catch {
      throw new EditorError("INDEX_INVALID", "History index has invalid checkpoint ids");
    }
    if (!Object.hasOwn(value.sizes, id) || !Number.isSafeInteger(value.sizes[id]) || value.sizes[id] < 0) {
      throw new EditorError("INDEX_INVALID", "History index has invalid checkpoint sizes");
    }
  }
  return copyIndex2(
    /** @type {HistoryIndex} */
    value
  );
}
async function validateCheckpointFiles(dir, index) {
  for (const id of retainedIds(index)) {
    let details2;
    try {
      details2 = await stat5(join6(dir, `${id}${CHECKPOINT_SUFFIX}`));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new EditorError("INDEX_INVALID", "History index references a missing checkpoint");
      }
      throw error;
    }
    if (!details2.isFile() || details2.size !== index.sizes[id]) {
      throw new EditorError("INDEX_INVALID", "History index checkpoint size does not match");
    }
  }
}
function applyRetention(index, maxSteps, maxBytes) {
  const counts = /* @__PURE__ */ new Map();
  for (const id of index.snapshots) counts.set(id, (counts.get(id) ?? 0) + 1);
  const keptIds = retainedIds(index);
  let bytes = 0;
  for (const id of keptIds) bytes += index.sizes[id];
  let first = 0;
  while ((index.snapshots.length - first > maxSteps || bytes > maxBytes) && first < index.cursor) {
    const id = index.snapshots[first];
    counts.set(id, counts.get(id) - 1);
    if (counts.get(id) === 0 && id !== index.saved_id) bytes -= index.sizes[id];
    first += 1;
  }
  const snapshots = index.snapshots.slice(first);
  const cursor = index.cursor - first;
  const sizes = {};
  for (const id of /* @__PURE__ */ new Set([...snapshots, index.saved_id])) sizes[id] = index.sizes[id];
  return {
    ...index,
    snapshots,
    cursor,
    sizes
  };
}
async function openStore(options) {
  if (!options || typeof options.dir !== "string" || !Number.isSafeInteger(options.max_steps) || options.max_steps < 1 || !Number.isSafeInteger(options.max_bytes) || options.max_bytes < 1) {
    throw new EditorError("STORE_OPTIONS_INVALID", "Store options are invalid");
  }
  await mkdir4(options.dir, { recursive: true, mode: 448 });
  let index = null;
  try {
    index = validateIndex(JSON.parse(await readFile7(join6(options.dir, INDEX_NAME), "utf8")));
    await validateCheckpointFiles(options.dir, index);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof EditorError) throw error;
      throw new EditorError("INDEX_INVALID", "History index cannot be read");
    }
  }
  return new Store(options, index);
}
var CHECKPOINT_SUFFIX, INDEX_NAME, Store;
var init_store = __esm({
  "editor/src/store.mjs"() {
    init_errors();
    init_history();
    CHECKPOINT_SUFFIX = ".checkpoint";
    INDEX_NAME = "index.json";
    Store = class {
      /**
       * @param {{dir:string, max_steps:number, max_bytes:number}} options
       * @param {HistoryIndex|null} index
       */
      constructor(options, index) {
        this.dir = options.dir;
        this.maxSteps = options.max_steps;
        this.maxBytes = options.max_bytes;
        this.index = index;
        this.prunable = /* @__PURE__ */ new Set();
        this.mutationTail = Promise.resolve();
      }
      /**
       * @template T
       * @param {() => Promise<T>} operation
       * @returns {Promise<T>}
       */
      runMutation(operation) {
        const result = this.mutationTail.then(operation);
        this.mutationTail = result.then(() => void 0, () => void 0);
        return result;
      }
      /** @param {string} id */
      checkpointPath(id) {
        assertCheckpointId(id);
        return join6(this.dir, `${id}${CHECKPOINT_SUFFIX}`);
      }
      /** @param {Buffer} bytes @returns {Promise<CheckpointRef>} */
      async put(bytes) {
        if (!Buffer.isBuffer(bytes)) {
          throw new EditorError("CHECKPOINT_INVALID", "Checkpoint bytes must be a Buffer");
        }
        const expectedBytes = bytes.length;
        const id = sha2563(bytes);
        const path = this.checkpointPath(id);
        const pending = join6(this.dir, `${randomUUID6()}.ckpt-pending`);
        try {
          const writtenBytes = await writeDurable(pending, bytes);
          if (writtenBytes !== expectedBytes) {
            throw new EditorError("CHECKPOINT_WRITE_FAILED", "Checkpoint write was incomplete");
          }
          try {
            await link2(pending, path);
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const existing = await this.read(id);
            if (existing.length !== expectedBytes || !existing.equals(bytes)) {
              throw new EditorError("CHECKPOINT_CORRUPT", "Checkpoint bytes do not match their hash");
            }
          }
          return { id, bytes: expectedBytes };
        } finally {
          await unlinkIfExists3(pending);
        }
      }
      /** @param {string} id */
      async read(id) {
        const path = this.checkpointPath(id);
        let bytes;
        try {
          bytes = await readFile7(path);
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw new EditorError("CHECKPOINT_NOT_FOUND", "Checkpoint is not available");
          }
          throw error;
        }
        if (sha2563(bytes) !== id) {
          throw new EditorError("CHECKPOINT_CORRUPT", "Checkpoint bytes do not match their hash");
        }
        return bytes;
      }
      /** @returns {Promise<HistoryIndex|null>} */
      async load() {
        return this.index === null ? null : copyIndex2(this.index);
      }
      /** @param {HistoryIndex} index @returns {Promise<HistoryIndex>} */
      publish(index) {
        return this.runMutation(async () => {
          const validated = validateIndex(index);
          const next = applyRetention(validated, this.maxSteps, this.maxBytes);
          const previousIds = this.index === null ? /* @__PURE__ */ new Set() : retainedIds(this.index);
          const nextIds = retainedIds(next);
          const pending = join6(this.dir, `${randomUUID6()}.pending`);
          try {
            await writeDurable(pending, JSON.stringify(next));
            await validateCheckpointFiles(this.dir, validated);
            await rename4(pending, join6(this.dir, INDEX_NAME));
          } finally {
            await unlinkIfExists3(pending);
          }
          this.index = next;
          for (const id of previousIds) {
            if (!nextIds.has(id)) this.prunable.add(id);
          }
          return copyIndex2(next);
        });
      }
      /** @param {Set<string>} keepIds */
      prune(keepIds) {
        return this.runMutation(async () => {
          if (!(keepIds instanceof Set)) {
            throw new EditorError("RETENTION_INVALID", "Retention requires checkpoint ids");
          }
          const protectedIds = /* @__PURE__ */ new Set([
            ...keepIds,
            ...this.index === null ? [] : retainedIds(this.index)
          ]);
          for (const id of [...this.prunable]) {
            if (protectedIds.has(id)) continue;
            await unlinkIfExists3(this.checkpointPath(id));
            this.prunable.delete(id);
          }
        });
      }
    };
  }
});

// editor/src/owner.mjs
var owner_exports = {};
__export(owner_exports, {
  openOwner: () => openOwner,
  readManifest: () => readManifest
});
import { createHash as createHash6, randomUUID as randomUUID7 } from "node:crypto";
import { mkdir as mkdir5, readFile as readFile8 } from "node:fs/promises";
import { dirname as dirname4, isAbsolute as isAbsolute2, join as join7 } from "node:path";
async function readManifest(manifestPath) {
  let value;
  try {
    const bytes = await readFile8(manifestPath);
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("too large");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new EditorError("MANIFEST_INVALID", "Launch manifest cannot be read as JSON");
  }
  const absolute = (text) => typeof text === "string" && text.length > 0 && !text.includes("\0") && isAbsolute2(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || !absolute(value.original_path) || !absolute(value.data_dir) || !Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((item) => typeof item !== "string")) {
    throw new EditorError("MANIFEST_INVALID", "Launch manifest needs an absolute original_path and data_dir, and argv");
  }
  if (value.launch_id !== void 0 && !(typeof value.launch_id === "string" && /^[0-9a-f]{32}$/.test(value.launch_id))) {
    throw new EditorError("MANIFEST_INVALID", "Launch manifest launch_id must be 32 lowercase hex digits");
  }
  const manifest = { original_path: value.original_path, argv: value.argv, data_dir: value.data_dir };
  if (value.launch_id !== void 0) manifest.launch_id = value.launch_id;
  return manifest;
}
async function openOwner({ original_path: originalPath, argv, data_dir: dataDir, launch_id: launchId }, { entry, poll_ms: pollMs, on_close: onClose }) {
  const sessionId = randomUUID7();
  const claim = { original_path: originalPath, data_dir: dataDir, session_id: sessionId };
  const source = await claimSource(claim).catch((error) => {
    const lost = error?.code === "RECOVERY_REQUIRED" ? error.details?.recovery?.session_id : void 0;
    if (typeof lost !== "string") throw error;
    return claimSource({ ...claim, adopt_orphan: lost });
  });
  let document;
  let renderer;
  let controller;
  let server;
  let mcp;
  let closing;
  function close() {
    closing ??= (async () => {
      let firstError;
      for (const step of [
        () => controller?.close(),
        () => server?.close(),
        () => renderer?.close(),
        () => document ? document.close() : source.release()
      ]) {
        try {
          await step();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    })();
    return closing;
  }
  try {
    const renderDir = join7(dataDir, "renders", sessionId);
    await mkdir5(renderDir, { recursive: true, mode: 448 });
    const documentKey = createHash6("sha256").update(source.original_path).digest("hex");
    const store = await openStore({ dir: join7(dataDir, "history", documentKey), max_steps: 50, max_bytes: 200 * 1024 * 1024 });
    document = await openDocument({ source, store, cli_argv: argv, recovery: "prompt" });
    renderer = createRenderer({ document, dir: renderDir });
    controller = new PanelController({ document, renderer, poll_ms: pollMs });
    mcp = { command: "node", args: [join7(dirname4(entry), "mcp.mjs"), "--document", document.info().original_path, "--data-dir", dataDir] };
    server = await startServer({
      document,
      renderer,
      registry: { data_dir: dataDir, launch_id: launchId },
      mcp,
      onClose,
      ui: {
        selectNode: (view) => controller.selectNode(view.path),
        focus: () => ({ frame_id: controller.frameId, selected_node: controller.selectedPath })
      }
    });
    controller.useBoard(server.board);
    await controller.start();
    void renderer.refresh(document.info().revision).catch(() => void 0);
  } catch (error) {
    await close().catch(() => void 0);
    throw error;
  }
  return { controller, document, close, mcp, window: server.window };
}
var MAX_MANIFEST_BYTES;
var init_owner = __esm({
  "editor/src/owner.mjs"() {
    init_document();
    init_errors();
    init_panel_model();
    init_render();
    init_server();
    init_source();
    init_store();
    MAX_MANIFEST_BYTES = 1024 * 1024;
  }
});

// editor/src/main.mjs
import { mkdir as mkdir6, rm as rm5, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename3, join as join8, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// editor/src/entry.mjs
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
function isEntry(metaUrl) {
  try {
    return Boolean(process.argv[1]) && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// editor/src/main.mjs
init_errors();

// editor/src/orphan.mjs
function watchOrphan({ idle_ms, renew, limit_ms, check_ms, on_expired, now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  let last = now();
  let stopped = false;
  const timer = schedule(() => {
    const at = now();
    const suspended = at - last > check_ms * 3;
    last = at;
    if (stopped) return;
    if (suspended) {
      renew();
    } else if (idle_ms() > limit_ms) {
      stop();
      on_expired();
    }
  }, check_ms);
  timer?.unref?.();
  function stop() {
    if (stopped) return;
    stopped = true;
    cancel(timer);
  }
  return stop;
}

// editor/src/main.mjs
var USAGE = "Usage: editor.mjs --launch <manifest.json>";
var ORPHAN_MS = 12e4;
var ORPHAN_CHECK_MS = 5e3;
function parseArguments(argv) {
  const [mode, manifest, ...extra] = argv.slice(2);
  if (mode !== "--launch" || extra.length > 0 || typeof manifest !== "string" || manifest.length === 0) throw new EditorError("USAGE", USAGE);
  return { mode: "owner", manifest };
}
function fail(error) {
  const code = typeof error?.code === "string" ? error.code : "EDITOR_FAILED";
  return { code, message: error instanceof EditorError ? error.message : "Editor failed" };
}
async function recordFailure(manifest, { data_dir: dataDir, launch_id: launchId }, error) {
  if (launchId === void 0) return;
  try {
    await mkdir6(dataDir, { recursive: true, mode: 448 });
    await writeFile2(join8(dataDir, basename3(manifest).replace(/\.json$/, ".failed")), JSON.stringify({ code: fail(error).code }), { mode: 384 });
  } catch {
  }
}
async function startOwner(manifest, { entry = fileURLToPath3(import.meta.url), poll_ms, on_close } = {}) {
  const { openOwner: openOwner2, readManifest: readManifest2 } = await Promise.resolve().then(() => (init_owner(), owner_exports));
  const path = resolve2(manifest);
  const options = await readManifest2(path);
  await rm5(path, { force: true }).catch(() => void 0);
  try {
    return await openOwner2(options, { entry, poll_ms, on_close });
  } catch (error) {
    await recordFailure(path, options, error);
    throw error;
  }
}
var stdioGuarded = false;
function ignoreBrokenStdio() {
  if (stdioGuarded) return;
  stdioGuarded = true;
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => void 0);
}
async function ownerMode(manifest, entry, { events = process, exit = (code) => process.exit(code), orphan_ms = ORPHAN_MS, check_ms = ORPHAN_CHECK_MS } = {}) {
  ignoreBrokenStdio();
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) events.on(signal, () => stop.abort());
  const owner = await startOwner(manifest, { entry, on_close: () => stop.abort() });
  const unwatch = watchOrphan({
    idle_ms: owner.window.idle_ms,
    renew: owner.window.renew,
    limit_ms: orphan_ms,
    check_ms,
    on_expired: () => {
      process.stderr.write(`Pencil editor ended: no window asked for it in ${Math.round(orphan_ms / 1e3)} s
`);
      stop.abort();
    }
  });
  if (!stop.signal.aborted) await new Promise((done) => stop.signal.addEventListener("abort", done, { once: true }));
  unwatch();
  const closed = await owner.close().then(() => 0, () => 1);
  exit(closed);
}
async function main() {
  const entry = fileURLToPath3(import.meta.url);
  let parsed;
  try {
    parsed = parseArguments(process.argv);
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: fail(error) }));
    process.exitCode = 2;
    return;
  }
  try {
    await ownerMode(parsed.manifest, entry);
  } catch (error) {
    process.stderr.write(`Pencil editor failed to start: ${fail(error).code}
`);
    process.exit(1);
  }
}
if (isEntry(import.meta.url)) await main();
export {
  ORPHAN_MS,
  ownerMode,
  parseArguments,
  startOwner
};
