import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Group, Panel, Separator } from 'react-resizable-panels';
import './styles.css';
import { useS, connect } from './store';
import { TitleBar, Sidebar, BrowserDock, Settings } from './components/Shell';
import { CodeMode } from './components/CodeMode';
import { TeamDock } from './components/TeamDock';
import { ThreadMode } from './components/ThreadMode';
import { AgentMode } from './components/AgentMode';
import { BoardMode } from './components/BoardMode';

function App() {
  const { ready, mode, dock, settingsOpen, set } = useS();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      // Ctrl+B / Ctrl+1..4 belong to the shell (readline, tmux, Claude Code) while a terminal pane has focus
      if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      const m = ({ '1': 'agent', '2': 'code', '3': 'thread', '4': 'board' } as const)[e.key as '1'];
      if (m) { e.preventDefault(); set({ mode: m }); }
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); set({ dock: useS.getState().dock === 'team' ? null : 'team' }); }
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, []);
  if (!ready) return <div className="h-full grid place-items-center text-mute">Connexion au hub…</div>;
  return (
    <div className="h-full flex flex-col">
      <TitleBar />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <div className="flex-1 min-w-0">
          <Group orientation="horizontal">
            <Panel minSize={400}>
              {/* Code mode stays mounted so terminals keep their state across mode switches */}
              <div className={mode === 'code' ? 'h-full' : 'hidden'}><CodeMode /></div>
              {mode === 'thread' && <ThreadMode />}
              {mode === 'agent' && <AgentMode />}
              {mode === 'board' && <BoardMode />}
            </Panel>
            {dock && <>
              <Separator className="w-1 hover:bg-accent/40 transition-colors" />
              <Panel defaultSize={dock === 'browser' ? '40' : '24'} minSize={260}>{dock === 'team' ? <TeamDock /> : <BrowserDock />}</Panel>
            </>}
          </Group>
        </div>
      </div>
      {settingsOpen && <Settings />}
    </div>
  );
}

connect();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
