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
  env: { ...process.env, RC_HOSTS: 'mini,local', RCT_BIN: stub, STUB_RCT: stub,
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
assert.deepEqual(tools.map(t => t.name).sort(), ['create_project', 'new_project_form', 'project_status']);
const form = tools.find(t => t.name === 'new_project_form');
assert.equal(form._meta.ui.resourceUri, 'ui://rc-tmux/new-project');
ok('lists three tools, the form linked to its UI');

const res = await client.readResource({ uri: 'ui://rc-tmux/new-project' });
const html = res.contents[0].text;
assert.equal(res.contents[0].mimeType, 'text/html;profile=mcp-app');
assert.ok(html.includes('window.McpApps={') && !html.includes('/*__APP_CLIENT__*/'));
assert.ok(!/^\s*export\s*\{/m.test(html.slice(-2000)), 'no export left at the end of the client');
ok(`UI resource inlines the client (${Math.round(html.length / 1024)} KB)`);

const f = await client.callTool({ name: 'new_project_form', arguments: { name: 'recipes' } });
assert.deepEqual(f.structuredContent, { view: 'form', hosts: ['mini', 'local'], defaults: { name: 'recipes' } });
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

await client.close();
console.log(`all ${pass} passed`);
