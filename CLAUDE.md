# BridgeMind Local — notes for agents working on this repo

- Hub = Node 24 running `.ts` directly (type stripping): only erasable TS syntax (no enums, no parameter properties); import local files with the `.ts` extension.
- `npm run typecheck` (hub + web), `npm run build` (UI → dist/), `npm run dev` (hub watch + Vite on :5173).
- The installed app rebuilds itself from the latest commit on `main` at launch (scripts/update-app.ps1): work is shipped by committing to `main`. `npm run app:install` installs the current tree (not `npm run install`: `install` is an npm lifecycle name).
- Hub port 7777 (`BRIDGE_PORT`), data in `~/.bridgemind` (`BRIDGE_DATA`).
- Any new spawn path must go through `claudeArgs()` in hub/agents.ts, which wires MCP, hooks, protocol and token-lean flags.
- The protocol text in `protocol()` is paid on every turn of every agent: keep it short.
- UI strings are French.
