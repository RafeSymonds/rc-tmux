#!/usr/bin/env node
// rc-tmux MCP server: starts new rc-tmux projects on your machines from the
// Claude desktop app. Each project is `rct new` run over SSH (A1), and the
// new-project form is an MCP App the desktop app draws in the conversation.
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

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const HOSTS = (process.env.RC_HOSTS || 'mini').split(',').map(h => h.trim()).filter(Boolean);
const RCT_LOCAL = process.env.RCT_BIN || join(homedir(), '.local/bin/rct');
const UI = 'ui://rc-tmux/new-project';
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
// rct prints this as its last line over SSH, because the SSH server on some hosts
// (Tailscale SSH) reports exit status 0 whatever the command returned.
const EXIT_MARK = '__RCT_EXIT=';

// Same rules as `rct new`, checked here too so nothing unsafe reaches a shell.
const NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const REPO = /^([A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const HOST = /^[A-Za-z0-9._@-]+$/;

// The form's HTML, with the MCP Apps client inlined so the frame loads nothing
// from the network.
// The bundle is an ES module that ends in `export{a as App,...}`; an inline
// script can't import from itself, so that line becomes `window.McpApps = {...}`.
function uiHtml() {
  const bundle = readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  const exportLine = /export\s*\{([^}]*)\};?\s*$/;
  const names = bundle.match(exportLine)?.[1];
  if (!names) throw new Error('unexpected ext-apps bundle: no export list at its end');
  const globals = names.split(',').map(pair => {
    const [local, exported = local] = pair.trim().split(/\s+as\s+/);
    return `${JSON.stringify(exported)}:${local}`;
  });
  const client = bundle.replace(exportLine, `window.McpApps={${globals.join(',')}};`)
    .replace(/<\/script/gi, '<\\/script');
  return readFileSync(join(here, 'ui/new-project.html'), 'utf8').replace('/*__APP_CLIENT__*/', () => client);
}

// --- Jobs: `rct new` can take a minute, longer than a tool call should wait. ---

const jobs = new Map();

function argvFor(host, args) {
  if (host === 'local') return [RCT_LOCAL, ...args];
  // Every arg already matched a pattern above, so joining with spaces is safe.
  const remote = `~/.local/bin/rct ${args.join(' ')}; echo "${EXIT_MARK}$?"`;
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remote];
}

function parseOutput(log) {
  const repoUrl = log.match(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/)?.[0];
  const sessionUrl = log.match(/rct: open: (https:\/\/claude\.ai\/code\?environment=[A-Za-z0-9_]+)/)?.[1];
  const errors = log.split('\n').filter(l => l.startsWith('rct: ') && !l.startsWith('rct: open:'));
  return { repoUrl, sessionUrl, lastNote: errors.at(-1)?.slice(5) };
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
    const mark = job.log.match(new RegExp(`${EXIT_MARK}(\\d+)`));
    const exit = mark ? Number(mark[1]) : code;
    job.log = job.log.replace(new RegExp(`\\n?${EXIT_MARK}\\d+\\n?`), '\n').trimEnd();
    Object.assign(job, parseOutput(job.log));
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

// --- Server ---

function buildServer() {
  const server = new McpServer({ name: 'rc-tmux', version: '0.1.0' });
  const formResult = defaults => ({
    content: [{ type: 'text', text: `Showing the new-project form. Hosts: ${HOSTS.join(', ')}.` }],
    structuredContent: { view: 'form', hosts: HOSTS, defaults },
  });
  const optional = {
    host: z.string().regex(HOST).optional().describe(`SSH host to create it on. One of: ${HOSTS.join(', ')}. Default ${HOSTS[0]}.`),
    name: z.string().regex(NAME).max(64).optional()
      .describe('Session and folder name: letters, digits, ".", "_" and "-".'),
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
    inputSchema: optional,
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: UI } },
  }, async args => formResult(args));

  registerAppTool(server, 'create_project', {
    title: 'Create rc-tmux project',
    description: 'Start creating a new rc-tmux project now: runs `rct new` on the host, which creates the folder, '
      + 'a git repo with a first commit, the GitHub repo, adds it to rc-tmux and starts its Remote Control server. '
      + 'Returns at once with a jobId; poll project_status until it is done or failed.',
    inputSchema: { ...optional, name: optional.name.unwrap() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: UI } },
  }, async ({ host = HOSTS[0], name, repo, visibility = 'private', spawn: spawnMode = 'same-dir' }) => {
    if (!HOSTS.includes(host)) {
      return { isError: true, content: [{ type: 'text', text: `Unknown host ${host}. Hosts: ${HOSTS.join(', ')}.` }] };
    }
    try {
      const job = startJob({ host, name, repo, visibility, spawn: spawnMode });
      return { content: [{ type: 'text', text: jobText(job) }], structuredContent: { view: 'job', ...jobView(job) } };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
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
    if (!job) return { isError: true, content: [{ type: 'text', text: `No job ${jobId}. Jobs end when the server restarts.` }] };
    return { content: [{ type: 'text', text: jobText(job) }], structuredContent: jobView(job) };
  });

  registerAppResource(server, 'New project form', UI, { description: 'Form and progress view for new rc-tmux projects' },
    async () => ({ contents: [{ uri: UI, mimeType: RESOURCE_MIME_TYPE, text: uiHtml() }] }));

  return server;
}

await buildServer().connect(new StdioServerTransport());
