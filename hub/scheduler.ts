// Routines: cron-scheduled headless agent runs.
import { Cron } from 'croner';
import { blobs, all, get } from './db.ts';
import { runRoutineOnce } from './agents.ts';
import { emit } from './bus.ts';

export interface Routine { id: string; name: string; prompt: string; schedule: string; profile?: string; cwd?: string; enabled: boolean; notify?: string }
export const routines = blobs('routines');
const jobs = new Map<string, Cron>();
const booted = Date.now();

export function schedule(r: Routine) {
  jobs.get(r.id)?.stop();
  jobs.delete(r.id);
  if (!r.enabled) return;
  // runRoutineOnce is synchronous (returns a run id), so croner's protect cannot see overlaps: check our own running rows.
  // Only rows started by this process count, so a crashed run from a previous boot never blocks the routine.
  const fire = () => {
    if (get(`SELECT 1 FROM runs WHERE routine=? AND status='running' AND started>=?`, r.id, booted)) return;
    try { runRoutineOnce(r); } catch (e: any) { emit('error', `routine ${r.name}: ${e.message}`); }
  };
  try { jobs.set(r.id, new Cron(r.schedule, { protect: true }, fire)); } catch (e: any) { emit('error', `routine ${r.name}: ${e.message}`); }
}
export const nextRun = (id: string) => jobs.get(id)?.nextRun()?.getTime() ?? null;
export const routinesView = () => routines.list<Routine>().map((r) => ({ ...r, next: nextRun(r.id) }));
export const recentRuns = () => all('SELECT * FROM runs ORDER BY id DESC LIMIT 100');
export function startScheduler() { for (const r of routines.list<Routine>()) schedule(r); }
export function stopRoutine(id: string) { jobs.get(id)?.stop(); jobs.delete(id); }
