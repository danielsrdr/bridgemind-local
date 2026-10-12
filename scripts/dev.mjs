// Dev: hub + vite with HMR, window pointed at vite.
import { spawn } from 'node:child_process';
const run = (cmd, args, env = {}) => spawn(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
run('node', ['--watch-path=hub', 'hub/index.ts']);
run('npx', ['vite']);
