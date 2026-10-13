# BridgeMind Local

Workspace multi-agent **100 % local et gratuit** pour Claude Code (et les LLM locaux via Ollama).
Remplace BridgeMind : terminaux splitables, threads, routines planifiées, dictée vocale locale, et surtout un **bus d'équipe** qui permet aux agents de se parler, de se répartir le travail et de déléguer à des workers moins chers.

Aucun abonnement en plus : les agents utilisent ton compte Claude Code existant (Pro/Max). Aucune donnée ne quitte la machine, à part les appels que Claude Code fait lui-même.

## Installer (appli Windows)

```bash
npm install
node node_modules/electron/install.js
npm run app:install
```

- `node node_modules/electron/install.js` télécharge le binaire Electron (npm ≥ 11 bloque les scripts d'installation).
- `npm run app:install` compile tout et crée `BridgeMind.exe`.
- L'appli est installée dans `%LOCALAPPDATA%\Programs\BridgeMind` (sans droits admin), avec un raccourci sur le bureau et dans le menu Démarrer.

**Toujours la dernière version** : le raccourci « BridgeMind » (bureau, menu Démarrer, recherche Windows) passe par un lanceur (`%LOCALAPPDATA%\Programs\BridgeMind-launcher`).
À chaque ouverture, il compare la version installée au dernier commit de `main` (local, ou `origin/main` s'il est en avance).
S'il y a du nouveau, il recompile dans un dossier à part (`%LOCALAPPDATA%\Programs\BridgeMind-build`) puis réinstalle, avant d'ouvrir l'appli.
- Seuls les changements **commités sur `main`** sont pris : les modifs en cours ne partent jamais dans l'appli.
- Si BridgeMind est déjà ouvert, il ne le ferme pas (les agents tourneraient encore) : la mise à jour se fera au prochain démarrage.
- Pour forcer une mise à jour : menu Démarrer → *BridgeMind - Mettre a jour*, ou `npm run update`. Journal : `~/.bridgemind/update.log`.
- Si la compilation échoue, la version installée est conservée.
- Elle apparaît dans *Paramètres → Applications installées*, d'où on peut la désinstaller.

C'est une vraie appli de bureau, comme l'appli Claude : fenêtre sans cadre avec barre de titre intégrée, icône dans la barre des tâches, instance unique et icône près de l'horloge.
- **Fermer la fenêtre** la cache près de l'horloge : les agents continuent de tourner.
- **Quitter** (clic droit sur l'icône → Quitter) arrête le hub et tous les agents.

Développement :
- `npm run dev` : hub en watch + Vite HMR sur http://localhost:5173.
- `npm run app` : appli Electron lancée depuis les sources.
- Sans Electron, `scripts/launch.vbs` ouvre l'UI dans une fenêtre Edge.

Prérequis : Node ≥ 24 et Claude Code connecté une fois. Le CLI est détecté automatiquement (`~/.local/bin`, PATH, ou celui embarqué dans l'appli Claude Desktop).

## Les 3 modes

| Mode | Ce que ça fait |
|---|---|
| **Code** (Ctrl+2) | Grille de vrais terminaux (ConPTY) par workspace. Un clic lance Opus / Sonnet / Haiku / Local / PowerShell. Panes redimensionnables, *Tidy*, maximiser (Ctrl+Shift+M), navigation Ctrl+Alt+flèches, nouveau pane Ctrl+Shift+T. |
| **Thread** (Ctrl+3) | Toutes tes sessions Claude Code (CLI, appli desktop, panes) en conversation lisible : prompts, outils, diffs, résultats, tokens. Reprendre dans un pane, ou continuer en headless. |
| **Agent** (Ctrl+1) | **Missions** (un lead planifie et délègue à N workers, workflow Opus → Haiku → Sonnet configurable par rôle) + **routines** cron (brief headless planifié) + historique des runs (tokens, durée). |

Panneau **Équipe** (Ctrl+B) : agents en direct (● idle, ● working, ● en attente de permission), fil de messages (tu y participes en tant que `human`), tableau de tâches, notes partagées.
**Navigateur** : aperçu localhost docké à droite.
### Dictée vocale (parler au lieu de taper)

| Où | Comment | Moteur |
|---|---|---|
| **Partout dans Windows** (Windows Terminal, appli Claude, VS Code, navigateur…) | maintiens **Ctrl+Win**, parle, relâche → le texte est collé dans la fenêtre active | Whisper local (GPU), aucun envoi réseau |
| Dans BridgeMind | Ctrl+Espace ou 🎙 → va dans le champ ou le terminal actif | Whisper local |
| Dans le CLI Claude (panes, ton terminal) | maintiens **Espace** sur un prompt vide | dictée intégrée de Claude Code (activée dans `~/.claude/settings.json` et pour tous les agents) |

Réglages (⚙ → Dictée vocale) : raccourci (Ctrl+Win, Ctrl+Alt, Ctrl+Maj, Ctrl droit), modèle (base, small, large-v3-turbo), langue, Entrée automatique après la dictée.
Le modèle se télécharge au premier lancement (~250 Mo pour small), puis il reste en cache.
Mesuré sur l'Arc 130V : environ 2 s pour une phrase en small, 1 s en base.

## Comment les agents communiquent

Chaque agent lancé par BridgeMind est un vrai `claude` interactif (ou headless), câblé automatiquement :

- **MCP `bridge`** (HTTP, un seul serveur partagé) : `send`, `inbox`, `agents`, `task_add/claim/done`, `tasks`, `note_set/get`, `validate`, `spawn`, `stop`.
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
| Routage par rôle | Haiku low pour balayer/filtrer, Sonnet medium pour refactoriser, Opus high pour planifier/livrer |
| Prompt système identique pour tous les workers headless + démarrages espacés | cache partagé entre workers |
| Validation JSON Schema déterministe dans le hub (`validate` / `note_set` schema) | zéro token |

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
electron/   main.cjs (fenêtre, icône près de l'horloge, hub en process enfant) + preload.cjs
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
