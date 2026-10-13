export type Status = 'offline' | 'starting' | 'idle' | 'working' | 'waiting';
export interface Agent {
  name: string; role: string | null; profile: string | null; model: string | null; cwd: string | null; parent: string | null;
  kind: 'pane' | 'headless' | 'external'; status: Status; activity: string | null; session_id: string | null; transcript: string | null;
  workspace: string | null; created: number; seen: number;
}
export interface Message { id: number; frm: string; rcpt: string; body: string; ts: number; read: number }
export interface Task { id: number; title: string; detail: string | null; status: 'open' | 'claimed' | 'done' | 'failed'; assignee: string | null; creator: string | null; deps: string; result: string | null; ts: number; updated: number }
export interface Note { k: string; v: string; author: string; ts: number }
export interface Profile { id: string; name: string; kind: 'claude' | 'shell'; command?: string; args?: string[]; model?: string; env?: Record<string, string>; configDir?: string; permissionMode?: string; isDefault?: boolean; inheritMcp?: boolean }
export interface Workspace { id: string; name: string; folders: string[]; layout: { rows?: string[][] }; created: number; updated: number }
export interface Term { id: string; title: string; cwd: string; agent: string | null; workspace: string | null; cmd: string; args: string[]; pid: number; alive: boolean; started: number }
export interface Routine { id: string; name: string; prompt: string; schedule: string; profile?: string; cwd?: string; enabled: boolean; notify?: string; next: number | null }
export interface Tier { profile: string; effort?: string; worktree?: boolean }
export interface Workflow { tiers: Record<string, Tier>; warnAt: number; staggerMs: number }
export interface Run { id: number; routine: string | null; agent: string; started: number; ended: number | null; status: string; result: string | null; cost: number | null; tokens: number | null }
export interface Settings { claudePath: string; hub: string; dataDir: string; lastWorkspace: string | null; integrated: boolean; dictation: Dictation }
export interface Dictation { enabled: boolean; hotkey: string; model: string; language: string; autoEnter: boolean }
export interface ThreadMeta { id: string; path: string; project: string; cwd: string | null; title: string; mtime: number; size: number }
export interface Item { k: 'user' | 'text' | 'tool' | 'result' | 'thinking'; t: string; tool?: string; input?: any; err?: boolean; ts?: string }
