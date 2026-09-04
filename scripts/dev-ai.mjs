/**
 * Start (or test) the FastAPI service with the local venv, on Windows and Unix.
 * npm scripts cannot use bash $(...) / ${VAR:-default} on PowerShell/cmd.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aiDir = path.join(root, 'ai-service');

function pythonBin() {
  const fromVenv = process.env.VIRTUAL_ENV
    ? path.join(
        process.env.VIRTUAL_ENV,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      )
    : null;
  const candidates = [
    path.join(aiDir, '.venv', 'Scripts', 'python.exe'),
    path.join(aiDir, '.venv', 'bin', 'python'),
    fromVenv,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const extra = process.argv.slice(2);
const args = extra.length
  ? extra
  : [
      '-m',
      'uvicorn',
      'app.main:app',
      '--reload',
      '--host',
      '0.0.0.0',
      '--port',
      process.env.RAG_SERVICE_PORT ?? '8000',
    ];

const child = spawn(pythonBin(), args, {
  cwd: aiDir,
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});

child.on('error', (err) => {
  console.error(`Failed to start Python at ai-service: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
