// Runs the server over stdio against a stub rct (test/stub-rct) and a fake ssh
// (test/bin/ssh) that always exits 0, as Tailscale SSH does.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, 'stub-rct');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, '..', 'server.mjs')],
  env: { ...process.env, RC_HOSTS: 'mini,local,down', RCT_BIN: stub, STUB_RCT: stub,
    PATH: `${join(here, 'bin')}:${process.env.PATH}` },
});
const client = new Client({ name: 'test', version: '0' });
await client.connect(transport);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function finish(jobId) {
  for (let i = 0; i < 30; i++) {
    const r = await client.callTool({ name: 'project_status', arguments: { jobId } });
    if (r.structuredContent.status !== 'running') return r.structuredContent;
    await sleep(200);
  }
  throw new Error('job never finished');
}
let pass = 0;
const ok = (label) => { pass++; console.log(`ok ${pass} - ${label}`); };

const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(),
  ['create_project', 'new_project_form', 'project_status', 'rc_big', 'rc_log', 'rc_restart', 'rc_start', 'rc_status', 'rc_stop']);
assert.equal(tools.find(t => t.name === 'rc_status')._meta.ui.resourceUri, 'ui://rc-tmux/status');
const form = tools.find(t => t.name === 'new_project_form');
assert.equal(form._meta.ui.resourceUri, 'ui://rc-tmux/new-project');
ok('lists nine tools, the form and status linked to their UIs');

for (const uri of ['ui://rc-tmux/new-project', 'ui://rc-tmux/status']) {
  const res = await client.readResource({ uri });
  const html = res.contents[0].text;
  assert.equal(res.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(html.includes('window.McpApps={') && !html.includes('/*__APP_CLIENT__*/') && !html.includes('/*__BASE_CSS__*/'), uri);
  assert.ok(html.includes('--inverse-bg'), `${uri} has the base styles`);
}
ok('both UI pages inline the client and the base styles');

const f = await client.callTool({ name: 'new_project_form', arguments: { name: 'recipes' } });
assert.deepEqual(f.structuredContent, { view: 'form', hosts: ['mini', 'local', 'down'], defaults: { name: 'recipes' } });
ok('form returns hosts and prefill');

const bad = await client.callTool({ name: 'create_project', arguments: { name: 'a b' } });
assert.equal(bad.isError, true);
const badHost = await client.callTool({ name: 'create_project', arguments: { name: 'x', host: 'other' } });
assert.equal(badHost.isError, true);
ok('rejects a bad name and an unknown host');

const started = await client.callTool({ name: 'create_project', arguments: { name: 'recipes', repo: 'recipe-box' } });
assert.equal(started.structuredContent.status, 'running');
const dup = await client.callTool({ name: 'create_project', arguments: { name: 'recipes' } });
assert.equal(dup.isError, true);
const done = await finish(started.structuredContent.jobId);
assert.equal(done.status, 'done', done.log);
assert.equal(done.repoUrl, 'https://github.com/someone/recipe-box');
assert.equal(done.sessionUrl, 'https://claude.ai/code?environment=env_01TESTrecipes');
assert.ok(!done.log.includes('__RCT_EXIT'));
ok('over ssh: runs, refuses a duplicate, ends done with both links');

const failed = await finish((await client.callTool({ name: 'create_project', arguments: { name: 'failing' } })).structuredContent.jobId);
assert.equal(failed.status, 'failed', 'ssh exit 0 must not hide the failure');
assert.equal(failed.error, 'GitHub repo failing already exists');
ok('over ssh: a failure is reported even though ssh exits 0');

const local = await finish((await client.callTool({ name: 'create_project', arguments: { name: 'loc', host: 'local', visibility: 'none' } })).structuredContent.jobId);
assert.equal(local.status, 'done', local.log);
const localFail = await finish((await client.callTool({ name: 'create_project', arguments: { name: 'fail2', host: 'local' } })).structuredContent.jobId);
assert.equal(localFail.status, 'failed');
ok('host local: done and failed from the exit code');

const st = await client.callTool({ name: 'rc_status', arguments: {} });
assert.equal(st.structuredContent.view, 'status');
assert.equal(st.structuredContent.hosts.length, 3);
for (const h of st.structuredContent.hosts.slice(0, 2)) {
  assert.ok(h.ok, h.error);
  assert.deepEqual(h.sessions.map(x => x.state), ['running', 'prompt']);
  assert.deepEqual(h.health.warnings, ['low disk', 'Chrome not running']);
}
const down = st.structuredContent.hosts[2];
assert.equal(down.ok, false); assert.equal(down.offline, true);
assert.match(down.error, /can't reach down: .*timed out/);
assert.match(st.content[0].text, /down: OFFLINE/);
assert.match(st.content[0].text, /3\.8 GB free of 228\.3 GB · load 2\.5 on 10 CPUs · Chrome not running {2}\(warning: low disk, Chrome not running\)/);
assert.match(st.content[0].text, /waiting on: Trust \/Users\/me\? \[y\/N\]/);
const one = await client.callTool({ name: 'rc_status', arguments: { host: 'mini' } });
assert.equal(one.structuredContent.hosts.length, 1);
ok('rc_status: every machine, or one, with states, the waiting question, health warnings and an offline machine');

const big = await client.callTool({ name: 'rc_big', arguments: {} });
assert.deepEqual(big.structuredContent.entries, [
  { kb: 26353340, name: 'rocket league', path: '~/rocket league' }, { kb: 3621512, name: 'screeps', path: '~/screeps' }]);
assert.ok(!(await client.callTool({ name: 'rc_big', arguments: { path: '~/games' } })).isError);
assert.equal((await client.callTool({ name: 'rc_big', arguments: { path: '/nope' } })).isError, true);
assert.equal((await client.callTool({ name: 'rc_big', arguments: { path: "~/x'; rm -rf ~" } })).isError, true);
assert.equal((await client.callTool({ name: 'rc_big', arguments: { host: 'down' } })).isError, true);
ok('rc_big: lists a folder, refuses a missing folder, a quote and an offline machine');

for (const tool of ['rc_start', 'rc_stop', 'rc_restart']) {
  const good = await client.callTool({ name: tool, arguments: { name: 'api' } });
  assert.ok(!good.isError, `${tool}: ${good.content[0].text}`);
  const bad = await client.callTool({ name: tool, arguments: { name: 'nope' } });
  assert.equal(bad.isError, true, `${tool} must fail for an unknown session even though ssh exits 0`);
  assert.match(bad.content[0].text, /no session named 'nope'/);
}
ok('start, stop, restart: succeed, and report an unknown session as an error');

const lg = await client.callTool({ name: 'rc_log', arguments: { name: 'api' } });
assert.match(lg.structuredContent.screen, /Connected/);
assert.match(lg.structuredContent.log, /claude remote-control/);
const lg2 = await client.callTool({ name: 'rc_log', arguments: { name: 'home' } });
assert.match(lg2.structuredContent.screen, /no window/);
assert.equal((await client.callTool({ name: 'rc_log', arguments: { name: 'nope' } })).isError, true);
ok('rc_log: screen and log, a session with no window, an unknown session');

const { prompts } = await client.listPrompts();
assert.deepEqual(prompts.map(p => p.name).sort(), ['rc-new', 'rc-restart', 'rc-status']);
const pn = await client.getPrompt({ name: 'rc-new', arguments: { name: 'recipes', repo: 'recipe-box' } });
assert.match(pn.messages[0].content.text, /new_project_form tool with name "recipes" and repo "recipe-box"/);
const pr = await client.getPrompt({ name: 'rc-restart', arguments: { name: 'api' } });
assert.match(pr.messages[0].content.text, /rc_restart/);
ok('prompts: rc-status, rc-new with arguments, rc-restart');

await client.close();
console.log(`all ${pass} passed`);
