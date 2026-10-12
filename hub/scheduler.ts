// Routines: cron-scheduled headless agent runs.
import { Cron } from 'croner';
import { blobs, all } from './db.ts';
import { runRoutineOnce } from './agents.ts';
import { emit } from './bus.ts';

export interface Routine { id: string; name: string; prompt: string; schedule: string; profile?: string; cwd?: string; enabled: boolean; notify?: string }
export const routines = blobs('routines');
const jobs = new Map<string, Cron>();

export function schedule(r: Routine) {
  jobs.get(r.id)?.stop();
  jobs.delete(r.id);
  if (!r.enabled) return;
  try { jobs.set(r.id, new Cron(r.schedule, { protect: true }, () => { runRoutineOnce(r); })); } catch (e: any) { emit('error', `routine ${r.name}: ${e.message}`); }
}
export const nextRun = (id: string) => jobs.get(id)?.nextRun()?.getTime() ?? null;
export const routinesView = () => routines.list<Routine>().map((r) => ({ ...r, next: nextRun(r.id) }));
export const recentRuns = () => all('SELECT * FROM runs ORDER BY id DESC LIMIT 100');
export function startScheduler() { for (const r of routines.list<Routine>()) schedule(r); }
export function stopRoutine(id: string) { jobs.get(id)?.stop(); jobs.delete(id); }
