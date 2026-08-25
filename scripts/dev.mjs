/**
 * Dev orchestrator: runs the authoritative game server (tsx watch) and the
 * Vite dev server side by side, and shuts both down together.
 */
import { spawn } from 'node:child_process';

const ESC = String.fromCharCode(27);
const color = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const targets = [
  { name: 'worker', code: 36, cmd: npx, args: ['wrangler', 'dev'] },
  { name: 'client', code: 35, cmd: npx, args: ['vite'] },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}

for (const target of targets) {
  const child = spawn(target.cmd, target.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push(child);

  const prefix = color(target.code, `[${target.name}]`) + ' ';
  const pipe = (stream, out) => {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (exitCode) => {
    if (shuttingDown) return;
    console.error(`${prefix}exited with code ${exitCode}`);
    shutdown(exitCode ?? 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(color(32, 'dev: client http://localhost:5173  |  server ws://localhost:8787/ws'));
