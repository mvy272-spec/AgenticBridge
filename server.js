import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = '0.0.0.0';
const PORT = 8080;
const ROOT = path.resolve(process.env.BRIDGE_ROOT || process.cwd());
const TOKEN = process.env.BRIDGE_TOKEN || 'CHANGE-ME-TO-A-LONG-RANDOM-TOKEN';

const subscribers = new Set();
const tasks = new Map();
const agents = new Map();

await fsp.mkdir(ROOT, { recursive: true });
await fsp.mkdir(path.join(__dirname, 'data'), { recursive: true });
await fsp.mkdir(path.join(__dirname, 'logs'), { recursive: true });

const tasksFile = path.join(__dirname, 'data/tasks.json');
try {
  const saved = JSON.parse(await fsp.readFile(tasksFile, 'utf8'));
  for (const [id, task] of Object.entries(saved)) tasks.set(id, task);
} catch {}

function saveTasks() {
  fsp.writeFile(tasksFile, JSON.stringify(Object.fromEntries(tasks), null, 2)).catch(() => {});
}

function authorized(req) {
  const supplied = Buffer.from(String(req.headers['x-bridge-token'] || ''));
  const expected = Buffer.from(TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function getAgentId(req) {
  return String(req.headers['x-agent-id'] || 'default').slice(0, 64);
}

function logAction(agentId, action, details = {}) {
  const entry = { time: new Date().toISOString(), agent: agentId, action, ...details };
  fsp.appendFile(path.join(__dirname, 'logs/actions.log'), JSON.stringify(entry) + '\n').catch(() => {});
  console.log(`[${entry.time}] [${agentId}] ${action}`);
}

function json(res, status, value) {
  const data = Buffer.from(JSON.stringify(value, null, 2));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function safePath(relative = '') {
  const normalized = String(relative).replaceAll('\\', '/').replace(/^\/+/, '');
  const target = path.resolve(ROOT, normalized);
  if (!target.toLowerCase().startsWith(ROOT.toLowerCase())) throw new Error('Path escapes root');
  return target;
}

function relative(target) {
  return path.relative(ROOT, target).replaceAll('\\', '/') || '.';
}

async function listDirectory(target) {
  const entries = await fsp.readdir(target, { withFileTypes: true });
  return Promise.all(entries.map(async entry => {
    const full = path.join(target, entry.name);
    const stat = await fsp.stat(full);
    return { name: entry.name, path: relative(full), type: entry.isDirectory() ? 'directory' : 'file', size: entry.isFile() ? stat.size : null, modified: stat.mtime.toISOString() };
  }));
}

async function handle(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Invalid token' });

  const agentId = getAgentId(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname.replace(/\/$/, '') || '/';
  agents.set(agentId, Date.now());

  if (req.method === 'GET' && route === '/api/health') {
    return json(res, 200, { ok: true, version: '4.2', root: ROOT, agents: Array.from(agents.keys()), tasks: tasks.size });
  }

  if (req.method === 'POST' && route === '/api/agent/tasks') {
    const body = await readJson(req);
    const id = body.id || crypto.randomUUID();
    tasks.set(id, { id, agent: agentId, command: body.command, args: body.args || {}, status: 'pending', created: Date.now() });
    saveTasks();
    logAction(agentId, 'task_created', { id });
    return json(res, 201, { ok: true, id });
  }

  if (req.method === 'GET' && route === '/api/agent/tasks') {
    return json(res, 200, { ok: true, tasks: Array.from(tasks.values()).filter(t => t.status === 'pending') });
  }

  if (req.method === 'POST' && route === '/api/agent/task/complete') {
    const body = await readJson(req);
    const task = tasks.get(body.id);
    if (task) { task.status = 'done'; task.result = body.result; saveTasks(); }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/api/shell/exec') {
    const { command, args = [], cwd = ROOT, timeout = 300000 } = await readJson(req);
    logAction(agentId, 'shell_exec', { command });
    return new Promise(resolve => {
      const child = spawn(command, args, { cwd, shell: true, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout?.on('data', d => stdout += d);
      child.stderr?.on('data', d => stderr += d);
      const timer = setTimeout(() => child.kill(), timeout);
      child.on('close', code => {
        clearTimeout(timer);
        logAction(agentId, 'shell_result', { exitCode: code });
        resolve(json(res, 200, { ok: true, result: { exitCode: code, stdout, stderr } }));
      });
    });
  }

  if (req.method === 'GET' && route === '/api/processes') {
    const { stdout } = await new Promise(r => execFile('powershell', ['-Command', 'Get-Process | Select Name,Id,CPU'], (e,o) => r({stdout:o||''})));
    return json(res, 200, { ok: true, processes: stdout });
  }

  if (req.method === 'POST' && route === '/api/process/kill') {
    const { pid } = await readJson(req);
    await new Promise(r => execFile('taskkill', ['/PID', pid, '/F'], () => r()));
    logAction(agentId, 'process_killed', { pid });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && route === '/api/list') {
    const target = safePath(url.searchParams.get('path') || '');
    return json(res, 200, { ok: true, items: await listDirectory(target) });
  }

  if (req.method === 'GET' && route === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>AgenticBridge v4.2 MAX</h1><p>Agents: ${Array.from(agents.keys()).join(', ')}</p><p>Tasks: ${tasks.size}</p>`);
    return;
  }

  return json(res, 404, { ok: false, error: 'Unknown route' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { if (!res.headersSent) json(res, 400, { ok: false, error: e.message }); });
});

server.listen(PORT, HOST, () => {
  console.log(`AgenticBridge v4.2 MAX running on http://${HOST}:${PORT}`);
  console.log(`Root: ${ROOT}`);
});