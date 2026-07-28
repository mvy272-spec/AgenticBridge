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
const ROOT = path.resolve(process.env.BRIDGE_ROOT || 'C:\\Users\\HITLERV8\\Downloads\\Human Music Radio');
const TOKEN = process.env.BRIDGE_TOKEN || 'CHANGE-ME-TO-A-LONG-RANDOM-TOKEN';
const MAX_JSON = 8 * 1024 * 1024;
const MAX_UPLOAD = 16 * 1024 * 1024 * 1024;

const subscribers = new Set();
const tasks = new Map();
const agents = new Map();

await fsp.mkdir(ROOT, { recursive: true });
await fsp.mkdir(path.join(__dirname, '../data'), { recursive: true });
await fsp.mkdir(path.join(__dirname, '../logs'), { recursive: true });

const tasksFile = path.join(__dirname, '../data/tasks.json');
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
  fsp.appendFile(path.join(__dirname, '../logs/actions.log'), JSON.stringify(entry) + '\n').catch(() => {});
  console.log(`[${entry.time}] [${agentId}] ${action}`);
}

function notify(event) {
  const payload = `event: bridge\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(payload);
}

function json(res, status, value) {
  const data = Buffer.from(JSON.stringify(value, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  });
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
  const rootLower = ROOT.toLowerCase();
  if (!target.toLowerCase().startsWith(rootLower)) throw new Error('Path escapes root');
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
    return {
      name: entry.name,
      path: relative(full),
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isFile() ? stat.size : null,
      modified: stat.mtime.toISOString()
    };
  }));
}

async function handle(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Invalid token' });

  const agentId = getAgentId(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname.replace(/\/$/, '') || '/';
  agents.set(agentId, Date.now());

  // HEALTH
  if (req.method === 'GET' && route === '/api/health') {
    return json(res, 200, {
      ok: true, version: '4.0-max', root: ROOT, pid: process.pid,
      agents: Array.from(agents.keys()), tasks: tasks.size
    });
  }

  // TASK QUEUE
  if (req.method === 'POST' && route === '/api/agent/tasks') {
    const body = await readJson(req);
    const id = body.id || crypto.randomUUID();
    const task = { id, agent: agentId, command: body.command, args: body.args || {}, status: 'pending', created: Date.now() };
    tasks.set(id, task);
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

  // SHELL
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

  // PROCESSES
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

  // REGISTRY
  if (req.method === 'POST' && route === '/api/registry/get') {
    const { path: regPath, name } = await readJson(req);
    const ps = `Get-ItemProperty -Path '${regPath}' -Name '${name}' | Select -Expand ${name}`;
    const { stdout } = await new Promise(r => execFile('powershell', ['-Command', ps], (e,o)=>r({stdout:o||''})));
    return json(res, 200, { ok: true, value: stdout.trim() });
  }

  // FILES
  if (req.method === 'GET' && route === '/api/list') {
    const target = safePath(url.searchParams.get('path') || '');
    return json(res, 200, { ok: true, items: await listDirectory(target) });
  }

  if (req.method === 'GET' && route === '/api/download') {
    const target = safePath(url.searchParams.get('path'));
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${path.basename(target)}"`
    });
    return fs.createReadStream(target).pipe(res);
  }

  if (req.method === 'PUT' && route === '/api/upload') {
    const target = safePath(url.searchParams.get('path'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    const ws = fs.createWriteStream(tmp);
    for await (const chunk of req) ws.write(chunk);
    ws.end();
    await fsp.rename(tmp, target);
    logAction(agentId, 'file_uploaded', { path: relative(target) });
    return json(res, 200, { ok: true, path: relative(target) });
  }

  if (req.method === 'DELETE' && route === '/api/path') {
    const target = safePath(url.searchParams.get('path'));
    await fsp.rm(target, { recursive: true, force: true });
    logAction(agentId, 'path_deleted', { path: relative(target) });
    return json(res, 200, { ok: true });
  }

  // DANGEROUS COMMAND CONFIRMATION
  if (req.method === 'POST' && route === '/api/confirm') {
    const body = await readJson(req);
    logAction(agentId, 'dangerous_confirmed', { command: body.command });
    return json(res, 200, { ok: true, confirmed: true });
  }

  // RECURSIVE SEARCH
  if (req.method === 'GET' && route === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const target = safePath(url.searchParams.get('path') || '');
    const results = [];
    async function walk(dir) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.toLowerCase().includes(query.toLowerCase())) results.push(relative(full));
      }
    }
    await walk(target);
    return json(res, 200, { ok: true, results });
  }

  // LAUNCH PROGRAM
  if (req.method === 'POST' && route === '/api/launch') {
    const { exe, args = [] } = await readJson(req);
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    logAction(agentId, 'program_launched', { exe });
    return json(res, 200, { ok: true, pid: child.pid });
  }

  // SIMPLE DASHBOARD
  if (req.method === 'GET' && route === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html>
<html><head><title>AgenticBridge v4</title></head>
<body style="font-family:monospace;background:#111;color:#0f0;padding:20px">
<h1>AgenticBridge v4 MAX</h1>
<p>Agents online: ${Array.from(agents.keys()).join(', ') || 'none'}</p>
<p>Pending tasks: ${tasks.size}</p>
<pre>Shell, Processes, Registry, Tasks — all available via API</pre>
</body></html>`);
  }

  return json(res, 404, { ok: false, error: 'Unknown route' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) json(res, 400, { ok: false, error: e.message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`AgenticBridge v4 MAX running on http://${HOST}:${PORT}`);
});