# Development

How Cora is put together, how to run it from source, and how a release is made.

## The repo

An npm workspace with four packages:

| Package | What it is |
|---|---|
| `packages/shared` | Types and pure logic used by the others (no I/O) |
| `packages/server` | The Cora server: Fastify on `127.0.0.1:4317`, SQLite (`node:sqlite`), Claude Code's hooks and transcripts, the MCP server sessions use, Cora's agent, the integrations. Also the CLI (`cora start`, `install`, …) and the terminal host |
| `packages/client` | The dashboard: React, zustand, three.js (react-three-fiber), built with Vite |
| `packages/desktop` | The Electron app: the window, tray, splash, built-in browser, updates, and anything that needs the desktop (notifications, 1Password) |

Design notes for each feature are in the design notes; the UI follows `docs/design-language.md`.

### How the pieces talk

- **Claude Code → Cora:** HTTP hooks (`~/.claude/settings.json`) post each event to the server; Cora also tails the
  transcripts in `~/.claude/projects`, so sessions started anywhere show up.
- **Sessions → Cora:** hosted sessions get Cora's MCP server (`/mcp`) for their tools; Cora's own agent proves itself
  with a key of its own.
- **Terminals:** sessions started in Cora run in the **terminal host**, a small separate process reached over a named
  pipe, so they outlive the server and the app.
- **Dashboard ↔ server:** HTTP and a WebSocket, signed in with a cookie; anything that acts also needs Cora's own
  origin.
- **Desktop app ↔ server:** the app starts the server (or reuses one that proves it's Cora) and loads the dashboard
  from it.

## Run from source

Requires Node 22+ and Windows (the terminal host and several integrations are Windows-first).

```bash
npm install
npm run build
npm run desktop                 # builds and launches the Electron app
```

Or the server alone:

```bash
npm run cora -- start           # prints the sign-in link and opens it
```

### The UI loop with simulated sessions

```bash
npm run cora -- start --sim --no-open --port 4318 --dev-origin http://localhost:5173
CORA_URL=http://127.0.0.1:4318 npm run dev:client
# then open http://localhost:5173/auth?key=<the key in ~/.cora/ui-token>
```

Point `CORA_HOME` at a scratch folder to keep the simulator's data apart from yours. `--sim-repo <checkout>` gives a
simulated session a real repo (for pipelines). `CORA_SIM_LITE=1` runs a light simulation (two sessions at a third of
the pace, resting between turns) for checking how something looks without loading the PC; `CORA_SIM_WILD=1` the
opposite, sessions fanning out wide and deep for a busy screenshot.

## Tests

```bash
npm test                        # vitest across all packages
npm run typecheck
```

Server tests include real captured hook payloads; client tests cover the pure logic (the scene, the composer, voice
cues…). Run a single file with `npx vitest run <path>`.

## Packaging and releases

```bash
node scripts/package.mjs                     # builds, then the Windows installer in release/dist
node scripts/package.mjs --no-build          # the installer from what's built
node scripts/package.mjs --version 0.1.2     # a test version without touching package.json
node scripts/package.mjs --publish           # also publishes the release (GitHub, via gh)
```

The installer is per-user NSIS, built with electron-builder (`packaging/`). The app runs the server with its own
Electron (as Node) and the terminal host on a bundled Node copied to `~/.cora/runtime`. Updates come from the releases
repository through electron-updater.

To try an installer without touching the copy you develop with, `scripts/try-fresh.ps1` installs it into a scratch
home on another port.

## Data and keys

Cora's data folder is `%USERPROFILE%\.cora` (`CORA_HOME` overrides it). Its keys: `token` (Claude Code's hooks),
`ui-token` (the dashboard), `view-token` (a read-only dashboard key for Cora's agent), `agent-token` (Cora's agent's
tools) and `host-token` (the terminal host). Sign-ins are sealed with `secrets.key`, protected by Windows DPAPI.
