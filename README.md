# BridgeMind Local

Workspace multi-agent **100 % local et gratuit** pour Claude Code (et les LLM locaux via Ollama).
Remplace BridgeMind : terminaux splitables, threads, routines planifiées, dictée vocale locale, et surtout un **bus d'équipe** qui permet aux agents de se parler, de se répartir le travail et de déléguer à des workers moins chers.

Aucun abonnement en plus : les agents utilisent ton compte Claude Code existant (Pro/Max). Aucune donnée ne quitte la machine, à part les appels que Claude Code fait lui-même.

## Démarrer

```bash
npm install
npm run build
powershell -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1
```

Ensuite, double-clique sur **BridgeMind** (bureau / menu Démarrer). Le hub démarre en arrière-plan sans console, et l'app s'ouvre dans une fenêtre dédiée (Edge `--app`, le même moteur WebView2 que Tauri, sans Rust à installer).
Fermer la fenêtre ne tue pas les agents. Pour tout arrêter : ⚙ → *Arrêter le hub*.

Pour le développement : `npm run dev` (hub en watch + Vite HMR sur http://localhost:5173).

Prérequis : Node ≥ 24 (SQLite intégré, exécution TypeScript native) et Claude Code connecté une fois. Le CLI embarqué dans l'appli Claude Desktop est détecté automatiquement.

## Les 3 modes

| Mode | Ce que ça fait |
|---|---|
| **Code** (Ctrl+2) | Grille de vrais terminaux (ConPTY) par workspace. Un clic lance Opus / Sonnet / Haiku / Local / PowerShell. Panes redimensionnables, *Tidy*, maximiser (Ctrl+Shift+M), navigation Ctrl+Alt+flèches, nouveau pane Ctrl+Shift+T. |
| **Thread** (Ctrl+3) | Toutes tes sessions Claude Code (CLI, appli desktop, panes) en conversation lisible : prompts, outils, diffs, résultats, tokens. Reprendre dans un pane, ou continuer en headless. |
| **Agent** (Ctrl+1) | **Missions** (un lead planifie et délègue à N workers) + **routines** cron (brief headless planifié) + historique des runs (tokens, durée). |

Panneau **Équipe** (Ctrl+B) : agents en direct (● idle, ● working, ● en attente de permission), fil de messages (tu y participes en tant que `human`), tableau de tâches, notes partagées.
**Navigateur** : aperçu localhost docké à droite.
**Dictée** : maintiens Ctrl+Espace (ou 🎙). Whisper tourne localement dans la fenêtre ; le texte va dans le champ actif ou dans le terminal focus.

## Comment les agents communiquent

Chaque agent lancé par BridgeMind est un vrai `claude` interactif (ou headless), câblé automatiquement :

- **MCP `bridge`** (HTTP, un seul serveur partagé) : `send`, `inbox`, `agents`, `task_add/claim/done`, `tasks`, `note_set/get`, `spawn`, `stop`.
- **Hooks HTTP** : statut en direct et **livraison push des messages, sans polling** :
  - agent en plein travail → les messages arrivent après son prochain appel d'outil (`PostToolUse`) ;
  - agent qui termine → son arrêt est bloqué et il reçoit les messages (`Stop`) ;
  - agent inactif → le hub tape une ligne de réveil dans son terminal, puis les messages sont injectés (`UserPromptSubmit`).
- **Protocole court** ajouté au system prompt (≈ 150 tokens) : messages ≤ 3 lignes, références (chemins, clés de notes, ids de tâches) plutôt que du contenu copié, délégation aux workers haiku.

Détails : [docs/PROTOCOL.md](docs/PROTOCOL.md).

### Optimisations tokens (mesurées)

| Réglage | Effet |
|---|---|
| `--strict-mcp-config` | les agents ne chargent que `bridge`, pas tes autres serveurs MCP |
| `--disable-slash-commands` pour les workers headless | pas de liste de skills à chaque tour |
| Workers `spawn(headless)` en haiku | résultat renvoyé en message ; au-delà de 1 500 caractères, il va dans une note (le parent ne le paie que s'il le lit) |
| Résultat dédoublonné | un worker qui a fait `task_done` n'envoie pas en plus son résultat final |
| `inbox(wait)` long-poll + hooks push | zéro tour gaspillé à attendre |

Même tâche headless : 167k → 58k tokens (−65 %), 2× plus rapide.

## Profils, multi-comptes, IA locale

⚙ → Profils. Un profil = modèle + permission mode + env + dossier de config.

- **Multi-comptes** : donne un `configDir` différent à chaque profil (`CLAUDE_CONFIG_DIR`), puis fais `/login` une fois dans un pane de ce profil.
- **IA locale** : profil *Local (Ollama)*. Installe [Ollama](https://ollama.com) ≥ 0.14 (API compatible Anthropic), puis `ollama pull qwen3-coder` (ou un modèle plus petit selon ta RAM). Le profil pointe déjà sur `http://localhost:11434`.
- **Permission mode** : pour des workers vraiment autonomes, mets `acceptEdits` ou `auto` sur le profil haiku. Les workers headless sont en `acceptEdits` par défaut.

### Faire rejoindre l'équipe à l'appli Claude Code

⚙ → *Intégration globale* → Activer : ajoute le MCP `bridge` et les hooks dans `~/.claude`. Une session de l'appli desktop peut alors appeler `join("nom")` et parler aux agents. Réversible avec le même bouton.

## Architecture

```
hub/        Node 24, un seul process, TypeScript exécuté nativement (pas de build)
  index.ts    HTTP API + WebSocket + fichiers statiques + boot
  bus.ts      agents / messages / tâches / notes (SQLite, node:sqlite)
  mcp.ts      serveur MCP Streamable HTTP minimal (JSON-RPC)
  hooks.ts    hooks HTTP de Claude Code → statut + livraison push
  agents.ts   profils, lancement claude (pane PTY ou headless), protocole
  pty.ts      ConPTY (@lydell/node-pty, prébuild), scrollback borné, frames de 16 ms
  scheduler.ts routines cron (croner)
  transcripts.ts  lecture des JSONL de Claude Code pour le mode Thread
web/        React 19 + Tailwind 4 + Zustand + xterm.js (WebGL)
```

Données : `~/.bridgemind/` (bridge.db, logs, configs runtime par agent).
