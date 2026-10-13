# Bridge protocol

## Identity
- Hub-spawned agents: MCP URL `http://127.0.0.1:7777/mcp?agent=<name>`, hooks `.../hook/<Event>?agent=<name>`.
- External sessions (global integration): unidentified until they call `join(name, role?)`. Their hooks are matched by `session_id`.
- The human operator is `human` (UI composer). Agents can `send(to:"human")`.

## Tools (server `bridge`)
| tool | args | notes |
|---|---|---|
| `send` | `to`, `body` | `to` = name, `all`, `@role`, or `a,b` |
| `inbox` | `wait?` (s, ≤300) | marks read; `wait` long-polls, so only use it when blocked |
| `agents` | – | live roster: name, role, status, model, activity |
| `task_add` | `title`, `detail?`, `assignee?`, `deps?` | with an assignee, it is sent to them directly |
| `task_claim` | `id?` | no id = oldest open task whose deps are done |
| `task_done` | `id`, `result`, `failed?` | messages the creator |
| `tasks` | `status?` | compact list |
| `note_set` / `note_get` | `key`, `value`, `schema?` / `key?` | shared blackboard; empty value deletes; no key lists keys; `schema?` = note key of a JSON Schema, invalid value is rejected |
| `validate` | `key`, `schema` | ok, or the schema errors |
| `spawn` | `prompt`, `name?`, `role?`, `model?`, `cwd?`, `headless?`, `effort?` (`low\|medium\|high\|xhigh\|max`), `worktree?` | role scan/validate/refactor routes model+effort (+worktree); no role and no model = haiku; parent = caller |
| `stop` | `name` | |

## Delivery (hooks, no polling)
| agent state | channel |
|---|---|
| working | `PostToolUse` → `additionalContext: "Team messages: …"` |
| ending a turn | `Stop` → `{decision:"block", reason:"New team messages: …"}` |
| idle at prompt | hub types `[bridge] N new team messages` + Enter → `UserPromptSubmit` injects them |

Message format seen by agents: `[sender→you #id] body`.

## Status
`starting` → (`UserPromptSubmit`/`PreToolUse`) `working` → (`Stop`) `idle`; `Notification` (permission prompt) → `waiting`; `SessionEnd`/exit → `offline`.

## Headless workers
`claude -p --output-format json` with `--strict-mcp-config --disable-slash-commands --exclude-dynamic-system-prompt-sections`, `acceptEdits`.
Their identity is in the first message, so every headless worker shares the same system prompt (cache prefix).
On exit, the result is mailed to the parent, unless the worker already reported through `task_done`. Results over 1 500 chars go to note `result/<name>`, and the message carries only a summary.

## Model workflow
Tiers live in kv `workflow` (`GET/POST /api/workflow`, editable in the Mission form). A role picks profile, effort and worktree when spawn leaves them unset.

| tier | model / effort | use |
|---|---|---|
| `lead` | opus / high | plans, merges, ships |
| `scan` | haiku / low | parallel sweeps, candidate extraction |
| `validate` | haiku / low | false positives, schema checks |
| `refactor` | sonnet / medium, worktree | precise edits in an isolated git worktree |

- Worktrees go to `<data>/worktrees/<repo>-<name>` on branch `bm/<name>` from HEAD. The lead merges them and removes them.
- `warnAt` (6): spawn warns the lead and messages the human when a lead has that many live workers.
- `staggerMs` (2000): headless starts of one model are spaced, so the first cache write serves the others.
