import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '0.0.0.0';
const PORT = 8080;
const ROOT = path.resolve(process.env.BRIDGE_ROOT || 'C:\Users\HITLERV8\Downloads\Human Music Radio');
const TOKEN = process.env.BRIDGE_TOKEN || 'CHANGE-ME-TO-A-LONG-RANDOM-TOKEN';
const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 1024 * 1024 * 1024 * 1024; // effectively unlimited
const subscribers = new Set();

await fsp.mkdir(ROOT, { recursive: true });

function authorized(req) {
  const supplied = Buffer.from(String(req.headers['x-bridge-token'] || ''));
  const expected = Buffer.from(TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function safePath(relative = '', allowRoot = true) {
  const normalized = String(relative).replaceAll('\\', '/').replace(/^\/+/, '');
  const target = path.resolve(ROOT, normalized);
  const rootLower = ROOT.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + path.sep.toLowerCase())) {
    throw new Error('Path escapes BRIDGE_ROOT');
  }
  if (!allowRoot && targetLower === rootLower) throw new Error('Operation on root is forbidden');
  return target;
}

function relative(target) {
  const value = path.relative(ROOT, target).replaceAll('\\', '/');
  return value || '.';
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

async function readBody(req, limit = MAX_JSON) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new Error(`Request body exceeds ${limit} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req);
  return body.length ? JSON.parse(body.toString('utf8')) : {};
}

function processResult(executable, args, cwd, timeout = 180000) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.killed) return reject(new Error('Process timed out'));
        resolve({ exitCode: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

function notify(event) {
  const payload = `event: bridge\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(payload);
}

async function listDirectory(target) {
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const items = await Promise.all(entries.map(async entry => {
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
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return items;
}

async function streamUpload(req, target) {
  const declared = Number(req.headers['content-length'] || -1);
  if (declared < 0 || declared > MAX_UPLOAD) throw new Error('Invalid Content-Length');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.bridge-${crypto.randomUUID()}.tmp`);
  let size = 0;
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new Error('Upload limit exceeded');
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    if (size !== declared) throw new Error(`Incomplete upload: ${size}/${declared}`);
    await fsp.rename(temporary, target);
    return size;
  } catch (error) {
    output.destroy();
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

async function handleAction(body) {
  const action = body.action;
  if (action === 'mkdir') {
    const target = safePath(body.path, false);
    await fsp.mkdir(target, { recursive: true });
    return { ok: true, path: relative(target) };
  }
  if (action === 'move' || action === 'copy') {
    const source = safePath(body.source, false);
    const destination = safePath(body.destination, false);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    if (action === 'move') await fsp.rename(source, destination);
    else await fsp.cp(source, destination, { recursive: true, errorOnExist: true });
    return { ok: true, [action]: { from: relative(source), to: relative(destination) } };
  }
  if (action === 'git') {
    const project = safePath(body.project || '');
    const operation = body.operation;
    let args;
    if (operation === 'init') args = ['init'];
    else if (operation === 'status') args = ['status', '--short', '--branch'];
    else if (operation === 'log') args = ['log', `-${Math.max(1, Math.min(Number(body.limit) || 20, 100))}`, '--oneline', '--decorate'];
    else if (operation === 'commit_all') {
      const message = String(body.message || 'Agent checkpoint').slice(0, 300);
      await processResult('git', ['config', 'user.name', 'Arena Agent'], project);
      await processResult('git', ['config', 'user.email', 'arena-agent@local'], project);
      await processResult('git', ['add', '-A'], project);
      args = ['commit', '-m', message];
    } else throw new Error('Allowed git operations: init, status, log, commit_all');
    const result = await processResult('git', args, project);
    return { ok: result.exitCode === 0, git: result };
  }
  if (action === 'zip_backup') {
    const project = safePath(body.project || '');
    const paths = body.paths || ['Assets', 'Packages', 'ProjectSettings'];
    const backup = path.join(project, '.agent_backups', `backup-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.zip`);
    await fsp.mkdir(path.dirname(backup), { recursive: true });
    const sources = paths.map(item => path.join(project, item)).filter(item => fs.existsSync(item));
    if (!sources.length) throw new Error('No backup sources exist');
    const ps = `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath @(${sources.map(x => `'${x.replaceAll("'", "''")}'`).join(',')}) -DestinationPath '${backup.replaceAll("'", "''")}' -Force`;
    const result = await processResult('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], project, 600000);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
    return { ok: true, archive: relative(backup), size: (await fsp.stat(backup)).size };
  }
  throw new Error(`Unknown action: ${action}`);
}

async function handle(req, res) {
  const auditPath = path.join(__dirname, '.audit.log');
  const auditEntry = { time: new Date().toISOString(), method: req.method, url: req.url, tokenPresent: !!req.headers['x-bridge-token'] };
  await fsp.appendFile(auditPath, JSON.stringify(auditEntry) + '\n');
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Invalid X-Bridge-Token' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'GET' && route === '/api/health') {
    return json(res, 200, { ok: true, version: '3.0-node', root: ROOT, pid: process.pid, time: new Date().toISOString(), capabilities: ['files', 'git', 'zip', 'unity-queue', 'desktop-capture', 'editor-log', 'sse'] });
  }
  // Retry / reconnect / process management / env / install / recursive / version / full content log
  if (req.method === 'POST' && route === '/api/process/kill') {
    const body = await readJson(req);
    const resKill = await processResult('taskkill', ['/F', '/PID', String(body.pid || '')], ROOT);
    return json(res, 200, { ok: resKill.exitCode === 0, kill: resKill });
  }
  if (req.method === 'GET' && route === '/api/env') {
    return json(res, 200, { ok: true, env: process.env });
  }
  if (req.method === 'POST' && route === '/api/env/set') {
    const body = await readJson(req);
    process.env[String(body.key)] = String(body.value);
    return json(res, 200, { ok: true, envSet: body.key });
  }
  if (req.method === 'POST' && route === '/api/install') {
    const body = await readJson(req);
    const cmd = String(body.command || '').replace(/[`$|;&<>\n\r]/g, '');
    const resInst = await processResult('cmd.exe', ['/c', cmd], ROOT, 600000);
    return json(res, 200, { ok: resInst.exitCode === 0, install: resInst });
  }
  if (req.method === 'GET' && route === '/api/list') {
    const target = safePath(url.searchParams.get('path') || '');
    return json(res, 200, { ok: true, path: relative(target), items: await listDirectory(target) });
  }
  if (req.method === 'GET' && route === '/api/download') {
    const target = safePath(url.searchParams.get('path'), false);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(target).pipe(res);
  }
  if (req.method === 'PUT' && route === '/api/file') {
    const target = safePath(url.searchParams.get('path'), false);
    const size = await streamUpload(req, target);
    notify({ type: 'file-written', path: relative(target), size });
    return json(res, 200, { ok: true, path: relative(target), size });
  }
  if (req.method === 'DELETE' && route === '/api/path') {
    const target = safePath(url.searchParams.get('path'), false);
    await fsp.rm(target, { recursive: true, force: false });
    notify({ type: 'path-deleted', path: relative(target) });
    return json(res, 200, { ok: true, deleted: relative(target) });
  }
  if (req.method === 'POST' && route === '/api/action') {
    return json(res, 200, await handleAction(await readJson(req)));
  }
  if (req.method === 'POST' && route === '/api/unity/command') {
    const body = await readJson(req);
    const project = safePath(body.project || '');
    const id = String(body.id || `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const commands = path.join(project, '.agent', 'commands');
    await fsp.mkdir(commands, { recursive: true });
    const command = { id, action: String(body.action), argument: String(body.argument || '') };
    await fsp.writeFile(path.join(commands, `${id}.json`), JSON.stringify(command, null, 2));
    notify({ type: 'unity-command', project: relative(project), ...command });
    return json(res, 202, { ok: true, id, command });
  }
  if (req.method === 'GET' && route === '/api/unity/result') {
    const project = safePath(url.searchParams.get('project') || '');
    const id = String(url.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const resultPath = path.join(project, '.agent', 'results', `${id}.json`);
    const result = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
    return json(res, 200, { ok: true, result });
  }
  if (req.method === 'POST' && route === '/api/desktop/capture') {
    const captures = safePath('AgentBridgeV3/captures');
    await fsp.mkdir(captures, { recursive: true });
    const output = path.join(captures, `desktop-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.png`);
    const script = path.join(__dirname, 'capture-screen.ps1');
    const result = await processResult('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputPath', output], __dirname, 60000);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
    return json(res, 200, { ok: true, path: relative(output), size: (await fsp.stat(output)).size });
  }
  if (req.method === 'GET' && route === '/api/editor/log') {
    const logPath = path.join(process.env.LOCALAPPDATA || '', 'Unity', 'Editor', 'Editor.log');
    const stat = await fsp.stat(logPath);
    const bytes = Math.max(1024, Math.min(Number(url.searchParams.get('bytes')) || 200000, 5 * 1024 * 1024));
    const start = Math.max(0, stat.size - bytes);
    const handle = await fsp.open(logPath, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    await handle.close();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
    return res.end(buffer);
  }
  if (req.method === 'POST' && route === '/api/unity/launch') {
    const body = await readJson(req);
    const project = safePath(body.project || '');
    const unityExe = path.resolve(String(body.unityExe || ''));
    if (path.basename(unityExe).toLowerCase() !== 'unity.exe' || !fs.existsSync(unityExe)) throw new Error('unityExe must point to an existing Unity.exe');
    const child = spawn(unityExe, ['-projectPath', project], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return json(res, 202, { ok: true, pid: child.pid, project: relative(project) });
  }
  if (req.method === 'GET' && route === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, time: new Date().toISOString() })}\n\n`);
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }
  if (req.method === 'POST' && route === '/api/self/request') {
    const body = await readJson(req);
    notify({ type: 'self-loop', payload: body, time: new Date().toISOString() });
    return json(res, 202, { ok: true, selfLoop: true, time: new Date().toISOString() });
  }
  if (req.method === 'POST' && route === '/api/shell') {
    const body = await readJson(req);
    const cmd = String(body.command || '').replace(/[`$|;&<>\n\r]/g, '');
    if (!cmd) throw new Error('No command');
    const result = await processResult('cmd.exe', ['/c', cmd], ROOT, body.timeout || 180000);
    return json(res, 200, { ok: true, shell: result });
  }
  if (req.method === 'GET' && route === '/api/processes') {
    const result = await processResult('tasklist', ['/FO', 'CSV', '/NH'], ROOT);
    return json(res, 200, { ok: true, processes: result.stdout.split('\n').filter(Boolean) });
  }
  if (req.method === 'POST' && route === '/api/registry') {
    const body = await readJson(req);
    const key = String(body.key || '').replace(/[^a-zA-Z0-9\\_\.\-]/g, '');
    const regCmd = `reg ${body.query || 'query'} "${key}" /v "${String(body.value || '').replace(/"/g, '\\"')}"`;
    const result = await processResult('cmd.exe', ['/c', regCmd], ROOT, 30000);
    return json(res, 200, { ok: true, registry: result });
  }
  if (req.method === 'POST' && route === '/api/task') {
    const body = await readJson(req);
    const queueFile = path.join(__dirname, '.agent_queue.json');
    const existing = fs.existsSync(queueFile) ? JSON.parse(await fsp.readFile(queueFile, 'utf8')) : [];
    existing.push({ ...body, id: crypto.randomUUID(), created: new Date().toISOString() });
    await fsp.writeFile(queueFile, JSON.stringify(existing, null, 2));
    return json(res, 200, { ok: true, queued: true, count: existing.length });
  }
  if (req.method === 'GET' && route === '/api/heartbeat') {
    await fsp.writeFile(path.join(__dirname, '.heartbeat.json'), JSON.stringify({ time: new Date().toISOString(), pid: process.pid, uptime: process.uptime() }));
    return json(res, 200, { ok: true, heartbeat: new Date().toISOString(), pid: process.pid, uptime: process.uptime() });
  }
  // Full audit with content + retry/reconnect info
  if (req.method === 'GET' && route === '/api/audit') {
    const auditPath = path.join(__dirname, '.audit.log');
    if (!fs.existsSync(auditPath)) return json(res, 200, { ok: true, audit: [] });
    const lines = (await fsp.readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean);
    return json(res, 200, { ok: true, audit: lines.map(l => JSON.parse(l)), reconnectAvailable: true, retryBackoff: 'exponential' });
  }
  // Multi-agent harmony + Arena SDK format
  if (req.method === 'POST' && route === '/api/agent/coord') {
    const body = await readJson(req);
    const coordFile = path.join(__dirname, '.agent_coord.json');
    const coord = fs.existsSync(coordFile) ? JSON.parse(await fsp.readFile(coordFile, 'utf8')) : { agents: [], tasks: [] };
    coord.agents.push({ id: body.agentId || crypto.randomUUID(), role: body.role || 'worker', time: new Date().toISOString() });
    await fsp.writeFile(coordFile, JSON.stringify(coord, null, 2));
    return json(res, 200, { ok: true, multiAgent: true, agents: coord.agents });
  }
  // Window autonomy: see open windows and interact
  if (req.method === 'GET' && route === '/api/windows') {
    const ps = "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
    const result = await processResult('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], ROOT, 30000);
    return json(res, 200, { ok: true, windows: JSON.parse(result.stdout || '[]') });
  }
  if (req.method === 'POST' && route === '/api/window/message') {
    const body = await readJson(req);
    const safeTitle = String(body.title || '').replace(/[^a-zA-Z0-9\s]/g, '').slice(0, 100);
    const safeText = String(body.text || '').replace(/[^a-zA-Z0-9\s\p{P}\p{L}]/gu, '').slice(0, 200);
    const ps = `$wshell = New-Object -ComObject WScript.Shell; $wshell.AppActivate('${safeTitle.replace("'","''")}'); $wshell.SendKeys('${safeText.replace("'","''")}')`;
    const result = await processResult('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], ROOT, 30000);
    return json(res, 200, { ok: true, messageSent: true, result: result.stdout || result.stderr });
  }
  if (req.method === 'POST' && route === '/api/arena/sdk') {
    const body = await readJson(req);
    // Arena SDK compatible format
    return json(res, 200, { ok: true, arenaSdk: true, payload: body, bridgeResponse: { version: '3.0-node', token: TOKEN ? 'set' : 'missing', capabilities: ['self-loop', 'multi-agent', 'audit', 'shell', 'registry', 'processes'] } });
  }
  return json(res, 404, { ok: false, error: 'Unknown route' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(new Date().toISOString(), error);
    if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : 400, { ok: false, error: error.message });
    else res.destroy(error);
  });
});

server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.listen(PORT, HOST, () => {
  console.log(`Agent Bridge v3 listening on http://${HOST}:${PORT}`);
  console.log(`Root: ${ROOT}`);
  console.log(`Node: ${process.version}`);
  if (TOKEN === 'CHANGE-ME-TO-A-LONG-RANDOM-TOKEN') console.warn('WARNING: default token is active.');
});
