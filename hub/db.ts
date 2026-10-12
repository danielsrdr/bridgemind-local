// SQLite persistence (node:sqlite, zero native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.BRIDGE_DATA ?? join(homedir(), '.bridgemind');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'bridge.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, folders TEXT NOT NULL, layout TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents(name TEXT PRIMARY KEY, role TEXT, profile TEXT, model TEXT, cwd TEXT, parent TEXT, kind TEXT NOT NULL DEFAULT 'pane',
  status TEXT NOT NULL DEFAULT 'offline', activity TEXT, session_id TEXT, transcript TEXT, workspace TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, frm TEXT NOT NULL, rcpt TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS msg_unread ON messages(rcpt, read);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open', assignee TEXT, creator TEXT,
  deps TEXT NOT NULL DEFAULT '[]', result TEXT, ts INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes(k TEXT PRIMARY KEY, v TEXT NOT NULL, author TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS routines(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT, routine TEXT, agent TEXT, started INTEGER NOT NULL, ended INTEGER, status TEXT NOT NULL,
  result TEXT, cost REAL, tokens INTEGER);
`);

export const all = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
export const get = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

export function kvGet<T>(k: string, def: T): T {
  const r = get<{ v: string }>('SELECT v FROM kv WHERE k=?', k);
  return r ? JSON.parse(r.v) : def;
}
export function kvSet(k: string, v: unknown) {
  run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v));
}

/** JSON-blob tables (profiles, routines). */
export const blobs = (table: 'profiles' | 'routines') => ({
  list: <T>() => all<{ data: string }>(`SELECT data FROM ${table}`).map((r) => JSON.parse(r.data) as T),
  get: <T>(id: string) => {
    const r = get<{ data: string }>(`SELECT data FROM ${table} WHERE id=?`, id);
    return r ? (JSON.parse(r.data) as T) : undefined;
  },
  put: (o: { id: string } & Record<string, any>) =>
    run(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, o.id, JSON.stringify(o)),
  del: (id: string) => run(`DELETE FROM ${table} WHERE id=?`, id),
});
