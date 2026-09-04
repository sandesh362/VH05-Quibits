import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = path.join(repoRoot, 'ai-service');
const venvPython = process.platform === 'win32'
  ? path.join(serviceRoot, '.venv', 'Scripts', 'python.exe')
  : path.join(serviceRoot, '.venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3');
const port = process.env.RAG_SERVICE_PORT ?? '8000';

const child = spawn(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--reload', '--host', '0.0.0.0', '--port', port],
  { cwd: serviceRoot, env: process.env, stdio: 'inherit' },
);

child.on('error', (error) => {
  console.error(`Could not start the AI service with ${python}: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
