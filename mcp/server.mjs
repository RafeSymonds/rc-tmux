#!/usr/bin/env node
// rc-tmux MCP server: manage rc-tmux on your machines from the Claude desktop
// app. Every action is `rct` run over SSH; the new-project form and the status
// dashboard are MCP Apps the desktop app draws in the conversation.
//
// Settings (environment, set by the desktop extension's options):
//   RC_HOSTS   comma-separated SSH hosts, first is the default (default: mini).
//              "local" runs rct on this machine instead of over SSH.
//   RCT_BIN    path to rct for host "local" (default: ~/.local/bin/rct).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const VERSION = '0.3.0';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const HOSTS = (process.env.RC_HOSTS || 'mini').split(',').map(h => h.trim()).filter(Boolean);
const RCT_LOCAL = process.env.RCT_BIN || join(homedir(), '.local/bin/rct');
const UI_NEW = 'ui://rc-tmux/new-project';
const UI_STATUS = 'ui://rc-tmux/status';
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const CALL_TIMEOUT_MS = 90 * 1000;
// rct prints this as its last line over SSH, because the SSH server on some hosts
// (Tailscale SSH) reports exit status 0 whatever the command returned.
const EXIT_MARK = '__RCT_EXIT=';

// Same rules as `rct new`, checked here too so nothing unsafe reaches a shell.
const NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const REPO = /^([A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const HOST = /^[A-Za-z0-9._@-]+$/;

// --- UI pages ---

// The MCP Apps client, inlined so a page's frame loads nothing from the network.
// The bundle is an ES module that ends in `export{a as App,...}`; an inline
// script can't import from itself, so that line becomes `window.McpApps = {...}`.
function appClient() {
  const bundle = readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  const exportLine = /export\s*\{([^}]*)\};?\s*$/;
  const names = bundle.match(exportLine)?.[1];
  if (!names) throw new Error('unexpected ext-apps bundle: no export list at its end');
  const globals = names.split(',').map(pair => {
    const [local, exported = local] = pair.trim().split(/\s+as\s+/);
    return `${JSON.stringify(exported)}:${local}`;
  });
  return bundle.replace(exportLine, `window.McpApps={${globals.join(',')}};`).replace(/<\/script/gi, '<\\/script');
}

function page(file) {
  const css = readFileSync(join(here, 'ui/base.css'), 'utf8');
  return readFileSync(join(here, 'ui', file), 'utf8')
    .replace('/*__BASE_CSS__*/', () => css)
    .replace('/*__APP_CLIENT__*/', () => appClient());
}

// --- Running rct ---

function argvFor(host, args) {
  if (host === 'local') return [RCT_LOCAL, ...args];
  // The remote shell reads this line, so each arg goes in single quotes; the
  // tools' patterns keep quotes and newlines out of every arg.
  if (args.some(a => /['\n\0]/.test(a))) throw new Error('an argument holds a quote or a newline');
  const remote = `~/.local/bin/rct ${args.map(a => `'${a}'`).join(' ')}; echo "${EXIT_MARK}$?"`;
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remote];
}

// The exit code from the marker when there is one, and the text without it.
function settle(text, code) {
  const mark = text.match(new RegExp(`${EXIT_MARK}(\\d+)`));
  return {
    exit: mark ? Number(mark[1]) : code,
    text: text.replace(new RegExp(`\\n?${EXIT_MARK}\\d+\\n?`), '\n').trim(),
  };
}

// Runs rct and resolves { exit, stdout, stderr, reached } once it ends.
// `reached` is false when SSH never got to the machine: no exit mark came back.
function runRct(host, args, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise(resolve => {
    const [cmd, ...rest] = argvFor(host, args);
    const child = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', err => { stderr += `\n${err.message}`; });
    child.on('close', code => {
      clearTimeout(timer);
      const reached = host === 'local' ? code !== null : stdout.includes(EXIT_MARK);
      const out = settle(stdout, code);
      resolve({ exit: code === null ? 124 : out.exit, stdout: out.text, stderr: stderr.trim(), reached });
    });
  });
}

// The last `rct: ...` line, which is how rct says what went wrong.
const rctError = text => text.split('\n').filter(l => l.startsWith('rct: ')).at(-1)?.slice(5);

// --- Jobs: `rct new` can take a minute, longer than a tool call should wait. ---

const jobs = new Map();

function parseNew(log) {
  const repoUrl = log.match(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/)?.[0];
  const sessionUrl = log.match(/rct: open: (https:\/\/claude\.ai\/code\?environment=[A-Za-z0-9_]+)/)?.[1];
  const notes = log.split('\n').filter(l => l.startsWith('rct: ') && !l.startsWith('rct: open:'));
  return { repoUrl, sessionUrl, lastNote: notes.at(-1)?.slice(5) };
}

function startJob({ host, name, repo, visibility, spawn: spawnMode }) {
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.host === host && job.name === name) {
      throw new Error(`${name} is already being created on ${host}`);
    }
  }
  const args = ['new', name];
  if (visibility === 'none') args.push('--no-repo');
  else {
    if (repo && repo !== name) args.push('--repo', repo);
    if (visibility === 'public') args.push('--public');
  }
  if (spawnMode === 'worktree') args.push('spawn=worktree');

  const job = { id: randomUUID(), host, name, status: 'running', log: '', startedAt: Date.now() };
  jobs.set(job.id, job);
  const [cmd, ...rest] = argvFor(host, args);
  const child = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
  const append = chunk => { job.log += chunk.toString(); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const timer = setTimeout(() => { job.timedOut = true; child.kill('SIGTERM'); }, JOB_TIMEOUT_MS);
  child.on('error', err => { job.log += `\n${err.message}\n`; });
  child.on('close', code => {
    clearTimeout(timer);
    const { exit, text } = settle(job.log, code);
    job.log = text;
    Object.assign(job, parseNew(job.log));
    job.status = exit === 0 && !job.timedOut ? 'done' : 'failed';
    if (job.timedOut) job.lastNote = 'stopped after 5 minutes';
    job.endedAt = Date.now();
  });
  return job;
}

function jobView(job) {
  const view = {
    jobId: job.id, host: job.host, name: job.name, status: job.status, log: job.log,
    repoUrl: job.repoUrl ?? null, sessionUrl: job.sessionUrl ?? null,
  };
  if (job.status === 'failed') view.error = job.lastNote ?? 'rct new failed; see the log';
  return view;
}

function jobText(job) {
  if (job.status === 'running') return `Creating ${job.name} on ${job.host}. Check again with project_status (jobId ${job.id}).`;
  if (job.status === 'failed') return `Creating ${job.name} on ${job.host} failed: ${jobView(job).error}\n\n${job.log}`;
  return [`Created ${job.name} on ${job.host}.`, job.repoUrl && `Repo: ${job.repoUrl}`,
    job.sessionUrl && `Session: ${job.sessionUrl}`].filter(Boolean).join('\n');
}

// --- Status ---

const LOW_DISK_KB = 5 * 1024 * 1024;   // warn under 5 GB free

// Free disk, load and Chrome, with what deserves a warning already worked out.
function healthOf(r, sessions) {
  if (r.exit !== 0) return null;   // an older rct without `health`: leave the strip out
  try {
    const h = JSON.parse(r.stdout);
    const warnings = [];
    if (h.diskFreeKB !== null && h.diskFreeKB < LOW_DISK_KB) warnings.push('low disk');
    if (h.load !== null && h.cpus && h.load > h.cpus) warnings.push('high load');
    if (!h.chrome && sessions.some(s => s.chrome === 'on')) warnings.push('Chrome not running');
    return { ...h, warnings };
  } catch {
    return null;
  }
}

async function hostStatus(host) {
  const [ls, health] = await Promise.all([runRct(host, ['ls', '--json']), runRct(host, ['health', '--json'])]);
  if (!ls.reached) {
    return { host, ok: false, offline: true, error: `can't reach ${host}: ${ls.stderr.split('\n').at(-1) || 'no answer over SSH'}` };
  }
  if (ls.exit !== 0) return { host, ok: false, error: rctError(ls.stderr) ?? (ls.stderr || `rct ls failed (${ls.exit})`) };
  try {
    const data = JSON.parse(ls.stdout);
    return { host, ok: true, machine: data.host, tmux: data.tmux, sessions: data.sessions, health: healthOf(health, data.sessions) };
  } catch {
    return { host, ok: false, error: `rct on ${host} has no ls --json; update rc-tmux there (git pull)` };
  }
}

const gb = kb => `${(kb / 1024 / 1024).toFixed(1)} GB`;

function healthLine(h) {
  if (!h) return null;
  const parts = [];
  if (h.diskFreeKB !== null) parts.push(`${gb(h.diskFreeKB)} free of ${gb(h.diskSizeKB)}`);
  if (h.load !== null) parts.push(`load ${h.load}${h.cpus ? ` on ${h.cpus} CPUs` : ''}`);
  parts.push(h.chrome ? 'Chrome running' : 'Chrome not running');
  return parts.join(' · ') + (h.warnings.length ? `  (warning: ${h.warnings.join(', ')})` : '');
}

function statusText(hosts) {
  return hosts.map(h => {
    if (!h.ok) return `${h.host}: ${h.offline ? 'OFFLINE. ' : ''}${h.error}`;
    const rows = h.sessions.map(s => `  ${s.name.padEnd(16)} ${s.state.padEnd(8)} ${s.folder}`
      + (s.question ? `\n    waiting on: ${s.question}` : ''));
    const line = healthLine(h.health);
    return [`${h.host}${h.tmux ? '' : ' (tmux not running)'}:`, ...(line ? [`  ${line}`] : []), ...rows].join('\n');
  }).join('\n\n');
}

// --- Server ---

function buildServer() {
  const server = new McpServer({ name: 'rc-tmux', version: VERSION });
  const hostArg = z.string().regex(HOST).optional()
    .describe(`Machine. One of: ${HOSTS.join(', ')}. Default ${HOSTS[0]}.`);
  const nameArg = z.string().regex(NAME).max(64).describe('The session name, as rc_status lists it.');
  const fail = text => ({ isError: true, content: [{ type: 'text', text }] });
  const known = host => HOSTS.includes(host);

  // New projects

  const projectArgs = {
    host: hostArg,
    name: z.string().regex(NAME).max(64).optional()
      .describe('Session and folder name: letters, digits, ".", "_" and "-". The folder is ~/<name> on the machine.'),
    repo: z.string().regex(REPO).max(140).optional()
      .describe('GitHub repo name, "repo" or "owner/repo". May differ from name. Default: name.'),
    visibility: z.enum(['private', 'public', 'none']).optional()
      .describe('"private" (default) or "public" GitHub repo, or "none" for no GitHub repo.'),
    spawn: z.enum(['same-dir', 'worktree']).optional()
      .describe('"same-dir" (default): sessions share the folder. "worktree": each session gets its own git worktree.'),
  };

  registerAppTool(server, 'new_project_form', {
    title: 'New rc-tmux project',
    description: 'Show a form to start a new rc-tmux project: a folder with a git repo and a GitHub repo on one of the '
      + 'user\'s machines, with a Claude Remote Control server running in it. Use this when the user wants to start a '
      + 'new project and has not given every detail; prefill what they did give.',
    inputSchema: projectArgs,
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: UI_NEW } },
  }, async args => ({
    content: [{ type: 'text', text: `Showing the new-project form. Machines: ${HOSTS.join(', ')}.` }],
    structuredContent: { view: 'form', hosts: HOSTS, defaults: args },
  }));

  registerAppTool(server, 'create_project', {
    title: 'Create rc-tmux project',
    description: 'Start creating a new rc-tmux project now: runs `rct new` on the machine, which creates ~/<name>, '
      + 'a git repo with a first commit, the GitHub repo, adds it to rc-tmux and starts its Remote Control server. '
      + 'Returns at once with a jobId; poll project_status until it is done or failed.',
    inputSchema: { ...projectArgs, name: projectArgs.name.unwrap() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: UI_NEW } },
  }, async ({ host = HOSTS[0], name, repo, visibility = 'private', spawn: spawnMode = 'same-dir' }) => {
    if (!known(host)) return fail(`Unknown machine ${host}. Machines: ${HOSTS.join(', ')}.`);
    try {
      const job = startJob({ host, name, repo, visibility, spawn: spawnMode });
      return { content: [{ type: 'text', text: jobText(job) }], structuredContent: { view: 'job', ...jobView(job) } };
    } catch (err) {
      return fail(err.message);
    }
  });

  server.registerTool('project_status', {
    title: 'rc-tmux project status',
    description: 'Status of a project create_project started: running, done (with repo and session links) or failed '
      + '(with the reason and rct\'s output).',
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: true },
  }, async ({ jobId }) => {
    const job = jobs.get(jobId);
    if (!job) return fail(`No job ${jobId}. Jobs end when the server restarts.`);
    return { content: [{ type: 'text', text: jobText(job) }], structuredContent: jobView(job) };
  });

  // Status and control

  registerAppTool(server, 'rc_status', {
    title: 'rc-tmux status',
    description: 'Show every rc-tmux session on the user\'s machines: state (running, prompt = waiting on a question, '
      + 'waiting = between restarts, stopped), folder, and its claude.ai link, plus each machine\'s health (online, '
      + 'free disk, load, Chrome running), in a dashboard with Restart, Stop, Start and Screen buttons and a '
      + 'largest-folders view. Leave host out to show every machine.',
    inputSchema: { host: hostArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: UI_STATUS } },
  }, async ({ host }) => {
    if (host && !known(host)) return fail(`Unknown machine ${host}. Machines: ${HOSTS.join(', ')}.`);
    const hosts = await Promise.all((host ? [host] : HOSTS).map(hostStatus));
    return { content: [{ type: 'text', text: statusText(hosts) }], structuredContent: { view: 'status', hosts, at: Date.now() } };
  });

  const control = [
    ['rc_start', 'up', 'Start', 'Start a stopped rc-tmux session (rct up).'],
    ['rc_stop', 'down', 'Stop', 'Stop an rc-tmux session with Ctrl-C (rct down). Its claude.ai sessions can be resumed for about 4 hours.'],
    ['rc_restart', 'restart', 'Restart', 'Restart an rc-tmux session (rct restart), for example when it is stuck or after a config change.'],
  ];
  for (const [tool, verb, title, description] of control) {
    server.registerTool(tool, {
      title: `${title} rc-tmux session`,
      description,
      inputSchema: { host: hostArg, name: nameArg },
      annotations: { readOnlyHint: false, destructiveHint: verb === 'down', idempotentHint: true, openWorldHint: true },
    }, async ({ host = HOSTS[0], name }) => {
      if (!known(host)) return fail(`Unknown machine ${host}. Machines: ${HOSTS.join(', ')}.`);
      const r = await runRct(host, [verb, name]);
      const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
      if (r.exit !== 0) return fail(rctError(text) ?? (text || `rct ${verb} failed (${r.exit})`));
      return { content: [{ type: 'text', text: text || `${title}: ${name} on ${host}` }], structuredContent: { ok: true, host, name, output: text } };
    });
  }

  server.registerTool('rc_log', {
    title: 'rc-tmux session screen and log',
    description: 'What an rc-tmux session\'s window shows now (claude\'s own output, any question it is waiting on) '
      + 'and the last lines of rct\'s log for it (starts, exits, restarts).',
    inputSchema: { host: hostArg, name: nameArg, lines: z.number().int().min(5).max(200).optional().describe('Screen lines, default 40.') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host = HOSTS[0], name, lines = 40 }) => {
    if (!known(host)) return fail(`Unknown machine ${host}. Machines: ${HOSTS.join(', ')}.`);
    const [screen, log] = await Promise.all([runRct(host, ['screen', name, String(lines)]), runRct(host, ['log', name, '-n', '15'])]);
    if (log.exit !== 0) return fail(rctError(log.stderr) ?? `no session ${name} on ${host}`);
    const shown = screen.exit === 0 ? screen.stdout : `(no window: ${rctError(screen.stderr) ?? 'stopped'})`;
    return {
      content: [{ type: 'text', text: `Screen:\n${shown}\n\nLog:\n${log.stdout}` }],
      structuredContent: { host, name, screen: shown, log: log.stdout },
    };
  });

  server.registerTool('rc_big', {
    title: 'Largest folders on an rc-tmux machine',
    description: 'List the largest entries in a folder on the machine (default its home folder), biggest first, '
      + 'to find what fills the disk. Read-only: it never deletes. Takes up to a minute on a big home folder. '
      + 'Call again with a path from the result to look inside it.',
    inputSchema: {
      host: hostArg,
      path: z.string().regex(/^(~|~\/[^'\n\0]*|\/[^'\n\0]*)$/).max(500).optional()
        .describe('Folder: absolute, or starting with ~/. Default ~.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host = HOSTS[0], path = '~' }) => {
    if (!known(host)) return fail(`Unknown machine ${host}. Machines: ${HOSTS.join(', ')}.`);
    const r = await runRct(host, ['big', path, '15'], 150 * 1000);
    if (!r.reached) return fail(`Can't reach ${host}.`);
    if (r.exit !== 0) return fail(rctError(r.stderr) ?? `rct big failed (${r.exit})`);
    const base = path.replace(/\/+$/, '');
    const entries = r.stdout.split('\n').filter(Boolean).map(line => {
      const [kb, ...rest] = line.split('\t');
      const name = rest.join('\t');
      return { kb: Number(kb), name, path: `${base}/${name}` };
    });
    const text = entries.map(e => `${gb(e.kb).padStart(9)}  ${e.name}`).join('\n') || '(empty)';
    return { content: [{ type: 'text', text: `Largest in ${path} on ${host}:\n${text}` }], structuredContent: { host, path, entries } };
  });

  registerAppResource(server, 'New project form', UI_NEW, { description: 'Form and progress view for new rc-tmux projects' },
    async () => ({ contents: [{ uri: UI_NEW, mimeType: RESOURCE_MIME_TYPE, text: page('new-project.html') }] }));
  registerAppResource(server, 'Status dashboard', UI_STATUS, { description: 'rc-tmux sessions on every machine' },
    async () => ({ contents: [{ uri: UI_STATUS, mimeType: RESOURCE_MIME_TYPE, text: page('status.html') }] }));

  // Slash commands (MCP prompts)

  const say = text => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });
  server.registerPrompt('rc-status', {
    title: 'rc status',
    description: 'Show every rc-tmux session and its state',
  }, () => say('Show my rc-tmux sessions with the rc_status tool.'));
  server.registerPrompt('rc-new', {
    title: 'rc new project',
    description: 'Start a new rc-tmux project',
    argsSchema: {
      name: z.string().optional().describe('Project name'),
      repo: z.string().optional().describe('GitHub repo, if it differs from the name'),
    },
  }, ({ name, repo }) => say(`Start a new rc-tmux project: show the new_project_form tool${name ? ` with name "${name}"` : ''}`
    + `${repo ? ` and repo "${repo}"` : ''}.`));
  server.registerPrompt('rc-restart', {
    title: 'rc restart',
    description: 'Restart an rc-tmux session',
    argsSchema: { name: z.string().describe('Session name') },
  }, ({ name }) => say(`Restart my rc-tmux session "${name}" with rc_restart, then show rc_status.`));

  return server;
}

await buildServer().connect(new StdioServerTransport());
