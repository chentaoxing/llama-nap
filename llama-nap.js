#!/usr/bin/env node
'use strict';
// llama-nap — an on-demand proxy for llama-server.
//
// Your model naps when idle and wakes up on the first real request.
// Zero dependencies, single file. The proxy itself uses no VRAM;
// llama-server is spawned only when traffic arrives and killed after
// `idleSeconds` of quiet, returning every megabyte to the GPU.
//
// SSRF note: the forwarding target is a constant built from the local
// backend port (127.0.0.1 only). Request paths are validated against an
// origin-form allowlist and re-bound to that constant origin via URL
// parsing; forwarded headers pass an explicit allowlist. No network
// input can influence protocol, host, or port.
//
// File policy: config and log use fixed constant filenames in the
// current working directory (dotenv-style). The backend binary path
// comes from that local config / CLI passthrough and must be absolute.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = '1.0.0';
const CONFIG_NAME = 'llama-nap.json'; // constant filenames only — no path input from CLI
const LOG_NAME = 'llama-nap.log';

// ---------- defaults ----------
const DEFAULTS = {
  listen: '127.0.0.1',        // localhost-only by default; set 0.0.0.0 to expose on LAN
  port: 13000,                // what clients (Hermes, Open WebUI, newapi, ...) connect to
  idleSeconds: 600,           // quiet time before the model naps (VRAM back to zero)
  bootTimeoutSeconds: 300,    // max wait for llama-server to load the model
  apiKey: '',                 // optional: require Bearer/x-api-key on everything but /health
  noWakePaths: ['/health'],   // probes that must NOT wake the model
  backend: {
    command: '',              // absolute path to llama-server binary
    args: [],                 // its arguments; ${PORT} is replaced, or --host/--port appended
    port: 0,                  // internal port (0 = proxy port + 1)
    healthPath: '/health',
  },
};

// ---------- tiny arg parser ----------
function parseCli(argv) {
  const flags = {};
  let passthrough = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { passthrough = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      flags[k] = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return { flags, passthrough };
}

function configExists() {
  try { fs.accessSync(CONFIG_NAME, fs.constants.R_OK); return true; } catch { return false; }
}

function loadConfig() {
  const { flags, passthrough } = parseCli(process.argv);
  if (flags.help) { console.log(HELP); process.exit(0); }
  if (flags.version) { console.log(`llama-nap v${VERSION}`); process.exit(0); }

  let cfg = structuredClone(DEFAULTS);
  // Fixed-name config in the working directory (constant string, no path input)
  if (configExists()) cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(CONFIG_NAME, 'utf8')));

  // CLI overrides (scalars only — no file paths)
  if (flags.listen) cfg.listen = flags.listen;
  if (flags.port) cfg.port = parseInt(flags.port, 10);
  if (flags.idle) cfg.idleSeconds = parseInt(flags.idle, 10);
  if (flags['boot-timeout']) cfg.bootTimeoutSeconds = parseInt(flags['boot-timeout'], 10);
  if (flags['api-key']) cfg.apiKey = flags['api-key'];
  // Backend: everything after `--` wins over config (shell-style)
  if (passthrough.length) { cfg.backend.command = passthrough[0]; cfg.backend.args = passthrough.slice(1); }

  if (!cfg.backend.command) { console.error('llama-nap: no backend command. Use `-- llama-server -m model.gguf ...` or backend.command in ' + CONFIG_NAME + '.\nSee --help.'); process.exit(1); }
  if (!path.isAbsolute(cfg.backend.command)) { console.error('llama-nap: backend.command must be an absolute path to the llama-server binary.'); process.exit(1); }
  if (!cfg.backend.port) cfg.backend.port = cfg.port + 1;
  return cfg;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

const HELP = `llama-nap v${VERSION} — wake your llama on demand, let it nap when idle.

Usage:
  llama-nap [options] -- <backend command and args...>
  llama-nap            # reads backend config from ./llama-nap.json

Options:
  --listen <addr>     bind address, default 127.0.0.1 (use 0.0.0.0 for LAN)
  --port <n>          proxy port, default 13000
  --idle <seconds>    unload model after this much quiet, default 600
  --boot-timeout <s>  max seconds to wait for model load, default 300
  --api-key <key>     require Bearer/x-api-key on inference endpoints
  --help, --version

Files (fixed names, resolved in the current working directory):
  llama-nap.json      optional config, see examples/config.example.json
  llama-nap.log       log output (rotated once at 5 MB)

Examples:
  llama-nap --idle 600 -- \\
    llama-server -m qwen.gguf -ngl 99 -c 8192 --flash-attn on
  curl -X POST http://127.0.0.1:13000/nap   # force nap right now`;

// ---------- runtime ----------
const cfg = loadConfig();
const BACKEND_HOST = '127.0.0.1'; // constant: backend is always loopback
const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${cfg.backend.port}`;
const SAFE_PATH = /^\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;
const ALLOW_HEADERS = new Set(['content-type', 'authorization', 'accept', 'x-api-key', 'x-request-id', 'openai-organization', 'openai-project', 'openai-beta']);
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const NO_WAKE = new Set(cfg.noWakePaths);

let child = null;
let booting = null;
let lastActivity = Date.now();
let activeReqs = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (fs.existsSync(LOG_NAME) && fs.statSync(LOG_NAME).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_NAME, LOG_NAME + '.1'); // single-generation rotation
    }
    fs.appendFileSync(LOG_NAME, line);
  } catch { /* logging must never break serving */ }
  process.stdout.write(line);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function healthOk() {
  try { return (await fetch(`${BACKEND_ORIGIN}${cfg.backend.healthPath}`, { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}

function buildBackendArgs() {
  const hadTemplate = cfg.backend.args.some(a => a.includes('${PORT}'));
  const raw = cfg.backend.args.map(a => a.replaceAll('${PORT}', String(cfg.backend.port)));
  return hadTemplate ? raw : [...raw, '--host', BACKEND_HOST, '--port', String(cfg.backend.port)];
}

function ensureServer() {
  if (child && child.exitCode === null) return Promise.resolve();
  if (booting) return booting;
  booting = (async () => {
    log('waking llama-server …');
    const fd = fs.openSync(LOG_NAME, 'a');
    child = spawn(cfg.backend.command, buildBackendArgs(), {
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('exit', (code) => { log(`llama-server exited (code=${code})`); child = null; booting = null; });
    const deadline = Date.now() + cfg.bootTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (!child) throw new Error('backend died during boot');
      if (await healthOk()) { log('llama-server is awake'); booting = null; return; }
      await sleep(2000);
    }
    try { child && child.kill(); } catch {}
    throw new Error(`backend did not become healthy within ${cfg.bootTimeoutSeconds}s`);
  })().catch(e => { log(`boot failed: ${e.message}`); booting = null; throw e; });
  return booting;
}

function napNow() {
  if (child) { log('forced nap via /nap'); try { child.kill(); } catch {} }
}

function authorized(req) {
  if (!cfg.apiKey) return true;
  const h = req.headers;
  const bearer = (h.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer === cfg.apiKey || h['x-api-key'] === cfg.apiKey;
}

const proxy = http.createServer(async (req, res) => {
  activeReqs++; lastActivity = Date.now();
  res.on('close', () => { activeReqs--; lastActivity = Date.now(); });

  const urlPath = req.url || '/';
  if (!SAFE_PATH.test(urlPath)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid request path' } }));
  }
  const target = new URL(urlPath, BACKEND_ORIGIN); // re-bind to constant origin
  if (target.origin !== BACKEND_ORIGIN) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'path escapes backend origin' } }));
  }
  const cleanPath = target.pathname;

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
  }
  if (cleanPath === '/nap') { napNow(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'nap' })); }
  if (!child && NO_WAKE.has(cleanPath)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'asleep', proxy: `llama-nap/${VERSION}` }));
  }

  try {
    await ensureServer();
    const headers = {};
    for (const k of Object.keys(req.headers)) if (ALLOW_HEADERS.has(k)) headers[k] = req.headers[k];
    headers.host = `${BACKEND_HOST}:${cfg.backend.port}`;
    const preq = http.request(target, { method: req.method, headers }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', (e) => {
      log(`forward error: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'llama backend error: ' + e.message } }));
    });
    req.pipe(preq);
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
});

proxy.listen(cfg.port, cfg.listen, () =>
  log(`llama-nap v${VERSION} listening on http://${cfg.listen}:${cfg.port} → ${BACKEND_ORIGIN} | nap after ${cfg.idleSeconds}s idle${cfg.apiKey ? ' | api-key: ON' : ''}`));

setInterval(() => {
  if (child && activeReqs === 0 && Date.now() - lastActivity > cfg.idleSeconds * 1000) {
    log(`idle > ${cfg.idleSeconds}s — putting llama-server to nap (VRAM released)`);
    try { child.kill(); } catch {}
  }
}, 15 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (child) child.kill(); process.exit(0); });
}
