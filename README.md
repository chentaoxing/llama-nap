# 🦙 llama-nap

**Your llama naps when idle, wakes on the first request, and gives every megabyte of VRAM back while you're away.**

`llama-server` holds your model in VRAM 24/7 — a 27B GGUF sits on ~18 GB even at 1% utilization, and watchdog scripts make it permanent. llama.cpp cannot unload weights from a running server, so the only way to get your GPU back is to stop the process. `llama-nap` does that for you, automatically, without changing a single client URL.

One file. Zero dependencies. Any OpenAI-compatible client keeps working.

```
   idle                          request arrives                 10 min quiet
┌──────────────┐   wake-on-first-request   ┌──────────────┐   auto-kill    ┌──────────────┐
│  VRAM: 0 MB  │ ────────────────────────▶ │  model loads │ ─────────────▶ │  VRAM: 0 MB  │
│  proxy alive │   (first request waits    │  requests    │  (no traffic   │  sleeps again│
│  ~20 MB RAM  │    for the model to boot)  │  stream OK   │   for a while) │              │
└──────────────┘                            └──────────────┘                └──────────────┘
```

## Quick start

Requires [Node.js](https://nodejs.org) ≥ 18. No install step — run the file directly:

```bash
node llama-nap.js --idle 600 -- \
  /path/to/llama-server -m /models/my-model.gguf -ngl 99 -c 8192 --flash-attn on
```

Point your clients (Open WebUI, Hermes, newapi, SDKs…) at `http://127.0.0.1:13000/v1`. That's it. The first request after a nap waits for the model to load; everything after that is normal speed.

<details>
<summary>Or use a config file</summary>

Drop a `llama-nap.json` next to where you run it (see [`examples/config.example.json`](examples/config.example.json)):

```bash
cd /path/to/llama-nap.json/dir
node /path/to/llama-nap.js
```
</details>

## What you get

| | |
|---|---|
| **Wake on demand** | llama-server is spawned only when a real request arrives, and requests are held until it's healthy |
| **Nap on idle** | killed after `idleSeconds` of quiet — VRAM returns to zero, no orphan processes |
| **Probes don't wake it** | `/health` answers `{"status":"asleep"}` from the proxy itself, so monitoring never loads your model for nothing |
| **Force a nap** | `curl -X POST http://127.0.0.1:13000/nap` when you need the GPU *now* |
| **Streaming works** | SSE / token streaming passes through untouched |
| **Crash-tolerant** | if llama-server dies, the next request just wakes a fresh one |
| **Localhost by default** | nothing is exposed to your LAN unless you ask; optional API key when you do |

## Configuration

CLI flags (scalars only):

| Flag | Default | Meaning |
|---|---|---|
| `--listen <addr>` | `127.0.0.1` | bind address; `0.0.0.0` to expose on LAN |
| `--port <n>` | `13000` | the port clients connect to |
| `--idle <seconds>` | `600` | quiet time before the model naps |
| `--boot-timeout <s>` | `300` | max wait for the model to load before erroring |
| `--api-key <key>` | *(off)* | require `Authorization: Bearer` / `x-api-key` on inference endpoints |

Config file `llama-nap.json` (read from the current working directory) adds `backend.command`, `backend.args`, `backend.port`, `backend.healthPath`, `noWakePaths`. Backend args may use `${PORT}`; if you don't use it, `--host 127.0.0.1 --port <backend.port>` is appended automatically — never pass `--port` yourself unless via `${PORT}`.

## Run it as a service

<details>
<summary><b>Linux (systemd user unit)</b></summary>

```ini
# ~/.config/systemd/user/llama-nap.service
[Unit]
Description=llama-nap on-demand llama-server proxy
After=network.target

[Service]
WorkingDirectory=%h/llama-nap
ExecStart=/usr/bin/node /path/to/llama-nap.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now llama-nap
```
</details>

<details>
<summary><b>Windows (silent autostart)</b></summary>

Create `start-llama-nap.vbs` in `shell:startup`:

```vbs
Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = "E:\llama-nap"   ' folder containing llama-nap.json
sh.Run """C:\Program Files\nodejs\node.exe"" ""E:\llama-nap\llama-nap.js""", 0, False
```

The proxy runs hidden and uses no VRAM until the first request.
</details>

<details>
<summary><b>macOS (launchd)</b></summary>

Use the same pattern as Linux: a plist with `WorkingDirectory`-equivalent `Key` + `ProgramArguments` pointing at node and `llama-nap.js`, then `launchctl load`. (PRs with a tested plist welcome.)
</details>

## Security

- **Default bind is `127.0.0.1`.** Anyone who can reach the proxy can wake your model — that's the feature, so treat the port like a GPU. If you set `--listen 0.0.0.0`, also set `--api-key`.
- The API key guards inference endpoints and `/nap`; `/health` stays open and leaks nothing (`{"status":"asleep"}`).
- Forwarding targets are hardcoded loopback constants; request paths are validated and re-bound to that origin; headers pass an allowlist. This is a local proxy, not a general-purpose reverse proxy — don't put it on the public internet.

## How is this different from …

| | llama-nap | [llama-swap](https://github.com/mostlygeek/llama-swap) | Ollama `keep_alive` | llama.cpp router mode |
|---|---|---|---|---|
| On-demand load + idle unload | ✅ | ✅ (TTL) | ✅ | manual `/models/load` |
| Multi-model swap / groups | ❌ single model | ✅ | ✅ | ✅ |
| Install | one file, `node x.js` | binary + YAML | full runtime | llama.cpp build |
| Keeps your exact llama-server flags (MTP, speculative, custom templates) | ✅ | ✅ | ⚠️ Modfile-limited | ✅ |
| Web UI, metrics, hooks | ❌ | ✅ | ✅ | ❌ |

**Pick llama-swap** if you juggle several models or want a dashboard. **Pick llama-nap** if you serve one tuned model and want the whole "stop wasting VRAM" story in a single dependency-free file you can read in ten minutes.

## FAQ

**How long is the cold start?** Model-dependent: ~15–90 s for a 27B Q4 from page cache / NVMe. Set client request timeouts above `--boot-timeout` if you care about the first request after a nap.

**Does the KV cache stay warm?** No — a nap is a full unload. That's where the VRAM comes from.

**Why does `/health` return 200 when asleep?** So orchestrators and dashboards polling health don't defeat the whole point by loading an 18 GB model every 30 s. Check `status` if you care.

**Anything I shouldn't do?** Don't run your own watchdog/keep-alive loop on top — llama-nap *is* the supervisor. Don't point two llama-nap instances at the same port.

## Development status

v1.0.0 — the author's daily driver for a Qwen3-27B on a 24 GB card (RTX 4090), verified end-to-end: wake, streaming, idle unload, forced nap, re-wake. Tested on Windows + Linux with llama.cpp `llama-server`; other OpenAI-compatible backends with a `/health` endpoint should work but are untested.

## License

[MIT](LICENSE)
