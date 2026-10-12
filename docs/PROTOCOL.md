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
| `note_set` / `note_get` | `key`, `value` / `key?` | shared blackboard; empty value deletes; no key lists keys |
| `spawn` | `prompt`, `name?`, `role?`, `model?`, `cwd?`, `headless?`, `effort?` | defaults to haiku, parent = caller |
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
`claude -p --output-format json` with `--strict-mcp-config --disable-slash-commands`, `acceptEdits`.
On exit, the result is mailed to the parent, unless the worker already reported through `task_done`. Results over 1 500 chars go to note `result/<name>`, and the message carries only a summary.
