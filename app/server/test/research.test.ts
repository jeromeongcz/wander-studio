import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { buildResearchPrompt, parseModelJson, validateTopics } from '../src/research/topics.ts';
import { checkLinks } from '../src/research/links.ts';
import { researchFromTopic } from '../src/research/service.ts';

// ---- a stand-in for the `claude` command ----
function stubDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wander-claude-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/bin/sh
D="$STUB_DIR"
if [ "$1" = "auth" ]; then
  if [ "$(cat "$D/auth" 2>/dev/null)" = "in" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi
  exit 0
fi
n=$(( $(cat "$D/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$D/count"
echo "$@" > "$D/args_$n"; pwd > "$D/cwd_$n"; ls -A > "$D/ls_$n"; cat > "$D/prompt_$n"
if [ -f "$D/sleep_$n" ]; then exec sleep 30; fi
cat "$D/answer_$n"
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'auth'), 'in');
  return {
    dir,
    bin,
    answer: (n: number, text: string) => writeFileSync(join(dir, `answer_${n}`), JSON.stringify({ is_error: false, result: text })),
    rawAnswer: (n: number, raw: string) => writeFileSync(join(dir, `answer_${n}`), raw),
    sleeps: (n: number) => writeFileSync(join(dir, `sleep_${n}`), '1'),
    signedIn: (v: boolean) => writeFileSync(join(dir, 'auth'), v ? 'in' : 'out'),
    calls: () => Number(existsSync(join(dir, 'count')) ? readFileSync(join(dir, 'count'), 'utf8') : 0),
    read: (name: string) => readFileSync(join(dir, name), 'utf8'),
  };
}

const OK = 'https://ok.example.org/a';
const fact = (n: number, url = OK) => ({ text: `This is documented fact number ${n} about the topic.`, source_url: `${url}${url === OK ? n : ''}`, source_title: 'A source' });
const topic = (title: string, over: object = {}) => ({ title, hook: `The surprising story of ${title}`, confidence: 'well-documented', facts: [fact(1), fact(2), fact(3)], ...over });
const answer = (...ts: object[]) => JSON.stringify({ topics: ts });

function fakeFetch(calls: string[] = []): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'ok.example.org') return new Response('x', { status: 200 });
    if (u.hostname === 'missing.example.org') return new Response(null, { status: 404 });
    if (u.hostname === 'blocked.example.org') return new Response(null, { status: 403 });
    if (u.hostname === 'redir.example.org') return new Response(null, { status: 302, headers: { location: 'https://ok.example.org/final' } });
    if (u.hostname === 'evil.example.org') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
    if (u.hostname === 'gone.example.org') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return new Response('x', { status: 200 });
  }) as typeof fetch;
}

function boot(opts: { stub?: ReturnType<typeof stubDir>; calls?: string[] } = {}) {
  const stub = opts.stub ?? stubDir();
  process.env.STUB_DIR = stub.dir;
  const root = mkdtempSync(join(tmpdir(), 'wander-research-'));
  const engine = new Engine(openDb());
  const app = buildApi(engine, { root, fetchFn: fakeFetch(opts.calls), llm: { claudeBin: stub.bin } });
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
  };
  const project = async (name = 'My secret project name', category = 'Mythology and Folklore') => (await call('POST', '/projects', { name, category, languages: ['en', 'tl'], formats: ['vertical_9x16'] })).json.id as string;
  const waitJob = async (id: string, ms = 20_000) => {
    const t0 = Date.now();
    for (;;) {
      const j = (await call('GET', `/jobs/${id}`)).json;
      if (['succeeded', 'failed', 'cancelled'].includes(j.state)) return j;
      assert.ok(Date.now() - t0 < ms, `job stuck in ${j.state}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  return { stub, root, engine, call, project, waitJob };
}

// ---------------- pure pieces ----------------
test('model answers are parsed from fences and surrounding prose; non-JSON is a clear error', () => {
  assert.deepEqual(parseModelJson('{"topics":[]}'), { topics: [] });
  assert.deepEqual(parseModelJson('Here you go:\n```json\n{"topics":[{"a":1}]}\n```\nHope that helps!'), { topics: [{ a: 1 }] });
  assert.deepEqual(parseModelJson('Sure! {"topics":[]} Anything else?'), { topics: [] });
  assert.deepEqual(parseModelJson('[1,2]'), [1, 2]);
  assert.throws(() => parseModelJson('I could not find anything.'), /did not contain any JSON/);
  assert.throws(() => parseModelJson('{"topics": [ {'), /incomplete|not valid/);
  assert.throws(() => parseModelJson('{"topics": [1,,2]}'), /not valid JSON/);
});

test('topic validation rejects weak or unsafe topics with a reason, and keeps clean ones', () => {
  const v = validateTopics({
    topics: [
      topic('Good topic'),
      topic('good   topic!'), // duplicate after normalising
      topic('Bad confidence', { confidence: 'certain' }),
      topic('One fact only', { facts: [fact(1)] }),
      topic('Only homepages', { facts: [{ text: 'A fact with only a homepage link.', source_url: 'https://example.org/' }, { text: 'Another fact with only a homepage.', source_url: 'https://example.org' }] }),
      topic('Script links', { facts: [{ text: 'A fact whose link is a script.', source_url: 'javascript:alert(1)' }, { text: 'A fact whose link is a file.', source_url: 'file:///etc/passwd' }, { text: 'One valid fact with a real page.', source_url: OK }] }),
      topic('', {}),
      topic('No hook', { hook: '' }),
      topic('Control\u0000 chars\u0007 and   spaces', { hook: '  A   hook\nwith\nlines  ' }),
      { title: 'Credentials', hook: 'A hook that works', confidence: 'legend', facts: [{ text: 'Fact one about the topic here.', source_url: 'https://user:pass@ok.example.org/a' }, { text: 'Fact two about the topic here.', source_url: 'https://ok.example.org/b' }] },
    ],
  });
  assert.deepEqual(v.topics.map((t) => t.title), ['Good topic', 'Control chars and spaces']);
  assert.equal(v.topics[1].hook, 'A hook with lines');
  const reasons = Object.fromEntries(v.rejected.map((r) => [r.title, r.reason]));
  assert.match(reasons['good topic!'], /duplicate/);
  assert.match(reasons['Bad confidence'], /confidence/);
  assert.match(reasons['One fact only'], /fewer than 2/);
  assert.match(reasons['Only homepages'], /fewer than 2/);
  assert.match(reasons['Script links'], /fewer than 2/, 'javascript: and file: links never count as sources');
  assert.match(reasons['(untitled)'], /missing title/);
  assert.match(reasons['No hook'], /missing hook/);
  assert.match(reasons['Credentials'], /fewer than 2/, 'links with embedded credentials are dropped');
  assert.equal(validateTopics({ topics: Array.from({ length: 9 }, (_, i) => topic(`Topic number ${i}`)) }, { max: 4 }).topics.length, 4, 'capped at the number asked for');
  assert.equal(validateTopics([topic('Array root')], { max: 5 }).topics.length, 1);
  assert.throws(() => validateTopics({ nope: 1 }), /Expected/);
  assert.deepEqual(validateTopics({ topics: [topic('Existing one')] }, { max: 5, avoid: ['existing one'] }).topics, [], 'existing titles are skipped');
  const many = validateTopics({ topics: [topic('Eight', { facts: Array.from({ length: 12 }, (_, i) => fact(i + 1)) })] }, { max: 5 });
  assert.equal(many.topics[0].facts.length, 8);
});

test('the research prompt carries the rules, category guidance, the count and the do-not-repeat list; custom categories get general guidance', () => {
  const p = buildResearchPrompt({ category: 'Food Origins', focus: 'Visayas', notes: 'street food', count: 4, avoid: ['Adobo origins'] });
  assert.match(p, /find 4 distinct video topic ideas in the category "Food Origins", focused on: Visayas/);
  assert.match(p, /NEVER invent a URL/);
  assert.match(p, /never write that someone "invented"/i);
  assert.match(p, /3 to 6 key facts/);
  assert.match(p, /"Adobo origins"/);
  assert.match(p, /street food/);
  assert.match(p, /Return ONLY a JSON object/);
  assert.match(buildResearchPrompt({ category: 'Philippine History', count: 2, avoid: [] }), /Give dates/);
  assert.match(buildResearchPrompt({ category: 'Superstitions', count: 2, avoid: [] }), /belief/);
  const custom = buildResearchPrompt({ category: 'Cooking for beginners', count: 1, avoid: [] });
  assert.match(custom, /"Cooking for beginners"/);
  assert.match(custom, /Prefer reputable sources and mark uncertain/);
  assert.ok(!/focused on/.test(custom));
});

test('link checking: reachable, blocked, missing and unknown-domain links; redirects followed; private addresses never contacted', async () => {
  const calls: string[] = [];
  const r = await checkLinks(['https://ok.example.org/a', 'https://missing.example.org/x', 'https://blocked.example.org/y', 'https://gone.example.org/z', 'https://redir.example.org/r', 'https://evil.example.org/r', 'http://localhost:4317/api', 'http://192.168.1.5/x', 'http://10.0.0.1/', 'https://user:pw@ok.example.org/a', 'ftp://ok.example.org/a', 'not a url', 'https://ok.example.org/a'], fakeFetch(calls));
  assert.equal(r.get('https://ok.example.org/a')!.status, 'reachable');
  assert.equal(r.get('https://missing.example.org/x')!.status, 'dead');
  assert.equal(r.get('https://blocked.example.org/y')!.status, 'unclear');
  assert.match(r.get('https://blocked.example.org/y')!.note, /block automated/);
  assert.equal(r.get('https://gone.example.org/z')!.status, 'dead');
  assert.match(r.get('https://gone.example.org/z')!.note, /domain not found/);
  assert.equal(r.get('https://redir.example.org/r')!.status, 'reachable', 'redirect followed to a live page');
  for (const bad of ['https://evil.example.org/r', 'http://localhost:4317/api', 'http://192.168.1.5/x', 'http://10.0.0.1/', 'https://user:pw@ok.example.org/a', 'ftp://ok.example.org/a', 'not a url']) assert.equal(r.get(bad)!.status, 'dead', bad);
  assert.ok(!calls.some((c) => /127\.0\.0\.1|localhost|192\.168|10\.0\.0/.test(c)), `no private address was contacted: ${calls.join(', ')}`);
  assert.equal(calls.filter((c) => c === 'https://ok.example.org/a').length, 1, 'duplicate links checked once');
});

test('a topic becomes research notes with every claim UNVERIFIED, sources de-duplicated, and a warning for dead links', () => {
  const t = { title: 'Topic', hook: 'The hook', confidence: 'legend', note: 'Oral tradition only', facts: [{ text: 'Fact one about it.', source_url: 'https://a.example.org/1', source_title: 'A', link_status: 'reachable' as const }, { text: 'Fact two about it.', source_url: 'https://a.example.org/1', link_status: 'reachable' as const }, { text: 'Fact three about it.', source_url: 'https://b.example.org/2', link_status: 'dead' as const }] };
  const r = researchFromTopic(t, 'Superstitions');
  assert.equal(r.topic, 'Topic');
  assert.equal(r.angle, 'The hook');
  assert.equal(r.category, 'Superstitions');
  assert.equal(r.sources.length, 2);
  assert.deepEqual(r.claims.map((c) => [c.status, c.sourceIds[0]]), [['unverified', 's1'], ['unverified', 's1'], ['unverified', 's2']]);
  assert.match(r.notes, /Confidence: legend\. Oral tradition only/);
  assert.match(r.notes, /Researched by AI/);
  assert.match(r.notes, /1 source link\(s\) did not load/);
  assert.equal(r.checklist.length, 5);
  assert.ok(r.checklist.every((c) => !c.done));
});

// ---------------- the bridge ----------------
test('status: signed in, signed out (with the exact sign-in command), and not installed', async () => {
  const t = boot();
  let s = (await t.call('GET', '/research/status')).json;
  assert.deepEqual([s.installed, s.loggedIn], [true, true]);
  t.stub.signedIn(false);
  s = (await t.call('GET', '/research/status')).json;
  assert.deepEqual([s.installed, s.loggedIn], [true, false]);
  assert.match(s.fix, /claude auth login/);
  const missing = boot({ stub: { ...t.stub, bin: '/nonexistent/claude' } as any });
  s = (await missing.call('GET', '/research/status')).json;
  assert.equal(s.installed, false);
  assert.match(s.fix, /claude auth login/);
});

test('the bridge runs Claude Code with web tools only, in an empty folder, and never sends the project name', async () => {
  const t = boot();
  t.stub.answer(1, answer(topic('Alpha'), topic('Beta')));
  const pid = await t.project('My secret project name', 'Food Origins');
  const r = await t.call('POST', `/projects/${pid}/research/batches`, { count: 2, focus: 'Cebu' });
  assert.equal(r.status, 202);
  const job = await t.waitJob(r.json.job.id);
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));

  const args = t.stub.read('args_1');
  assert.match(args, /-p/);
  assert.match(args, /--tools WebSearch,WebFetch/, 'only the web tools exist');
  assert.match(args, /--allowedTools WebSearch,WebFetch/);
  assert.match(args, /--permission-mode dontAsk/, 'anything else is denied, never prompted');
  assert.match(args, /--no-session-persistence/);
  assert.match(args, /--strict-mcp-config/);
  assert.match(args, /--disable-slash-commands/);
  assert.match(args, /--output-format json/);
  assert.ok(!/Bash|Edit|Write|Read/.test(args), `no file or shell tools: ${args}`);
  assert.ok(!/bypassPermissions|dangerously/.test(args));
  assert.equal(t.stub.read('ls_1').trim(), '', 'started in an empty folder');
  assert.ok(!t.stub.read('cwd_1').includes('Wander Studio') && !t.stub.read('cwd_1').includes(t.root), 'not inside the project or data folders');
  const prompt = t.stub.read('prompt_1');
  assert.ok(prompt.includes('Food Origins') && prompt.includes('Cebu'), 'category and focus are sent');
  assert.ok(!prompt.includes('My secret project name'), 'the project name is never sent');
  assert.ok(!prompt.includes(t.root) && !/\/Users\//.test(prompt), 'no file paths are sent');
  assert.ok(!existsSyncAfter(t.stub.read('cwd_1').trim()), 'the temporary folder is removed afterwards');
});
const existsSyncAfter = (p: string) => existsSync(p);

test('a batch researches in chunks, tells later chunks what to avoid, checks every link and stores the topics', async () => {
  const calls: string[] = [];
  const t = boot({ calls });
  t.stub.answer(1, answer(topic('One'), topic('Two'), topic('Three'), topic('Four', { facts: [fact(1), { text: 'A fact with a missing page link.', source_url: 'https://missing.example.org/x' }, { text: 'A fact with a blocking site link.', source_url: 'https://blocked.example.org/y' }] })));
  t.stub.answer(2, '```json\n' + answer(topic('Five'), topic('Six'), topic('Three'), topic('Bad', { facts: [] })) + '\n```');
  t.stub.answer(3, answer(topic('Seven')));
  const pid = await t.project();
  const r = await t.call('POST', `/projects/${pid}/research/batches`, { count: 7 });
  const job = await t.waitJob(r.json.job.id);
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.progress, 1);
  assert.deepEqual(job.result, { found: 7, requested: 7, rejected: 2 });
  assert.equal(t.stub.calls(), 3, 'four topics per Claude Code run');
  assert.match(t.stub.read('prompt_1'), /find 4 distinct/);
  assert.match(t.stub.read('prompt_2'), /find 3 distinct/);
  assert.match(t.stub.read('prompt_2'), /"One"; "Two"; "Three"; "Four"/, 'second run is told what already exists');
  assert.match(t.stub.read('prompt_3'), /find 1 distinct/);

  const { batches, ideas } = (await t.call('GET', `/projects/${pid}/research/topics`)).json;
  assert.equal(batches.length, 1);
  assert.equal(batches[0].state, 'done');
  assert.equal(batches[0].source, 'claude-code');
  assert.equal(batches[0].category, 'Mythology and Folklore');
  assert.deepEqual(batches[0].rejected.map((x: any) => x.title).sort(), ['Bad', 'Three']);
  assert.equal(ideas.length, 7);
  assert.ok(ideas.every((i: any) => i.status === 'new' && i.facts.length >= 3));
  const four = ideas.find((i: any) => i.title === 'Four');
  assert.deepEqual(four.links, { reachable: 1, unclear: 1, dead: 1, unchecked: 0 });
  assert.equal(four.facts.find((f: any) => f.source_url.includes('missing')).link_status, 'dead');
  assert.match(four.facts.find((f: any) => f.source_url.includes('blocked')).link_note, /block/);
  assert.ok(calls.length >= 3, 'links were checked');
});

test('a short answer is a partial batch, with the shortfall explained', async () => {
  const t = boot();
  t.stub.answer(1, answer(topic('Only one'), topic('Broken', { confidence: 'maybe' })));
  t.stub.answer(2, answer());
  t.stub.answer(3, answer());
  const pid = await t.project();
  const job = await t.waitJob((await t.call('POST', `/projects/${pid}/research/batches`, { count: 4 })).json.job.id);
  assert.equal(job.state, 'succeeded');
  const b = (await t.call('GET', `/projects/${pid}/research/topics`)).json.batches[0];
  assert.equal(b.state, 'partial');
  assert.equal(b.message, 'Found 1 of 4 topics.');
  assert.ok(b.rejected.some((x: any) => /confidence/.test(x.reason)));
});

test('not signed in: the job fails with the sign-in command and nothing is stored', async () => {
  const t = boot();
  t.stub.signedIn(false);
  const pid = await t.project();
  const job = await t.waitJob((await t.call('POST', `/projects/${pid}/research/batches`, { count: 3 })).json.job.id);
  assert.equal(job.state, 'failed');
  assert.equal(job.error.code, 'PROVIDER_ERROR');
  assert.match(job.error.message, /not signed in/);
  assert.match(job.error.message, /claude auth login/);
  assert.equal(t.stub.calls(), 0, 'no research was attempted');
  const { batches, ideas } = (await t.call('GET', `/projects/${pid}/research/topics`)).json;
  assert.equal(batches[0].state, 'failed');
  assert.match(batches[0].message, /claude auth login/);
  assert.equal(ideas.length, 0);
});

test('Claude Code errors and unusable answers fail clearly; an authentication error from the command is explained', async () => {
  for (const [label, setup, expect] of [
    ['api error', (s: ReturnType<typeof stubDir>) => s.rawAnswer(1, JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired' })), /not signed in.*claude auth login/s],
    ['other error', (s: ReturnType<typeof stubDir>) => s.rawAnswer(1, JSON.stringify({ is_error: true, result: 'Rate limit reached' })), /reported an error: Rate limit reached/],
    ['not json', (s: ReturnType<typeof stubDir>) => s.rawAnswer(1, 'Segmentation fault'), /unreadable/],
    ['empty', (s: ReturnType<typeof stubDir>) => s.answer(1, '   '), /empty answer/],
  ] as const) {
    const t = boot();
    setup(t.stub);
    const pid = await t.project();
    const job = await t.waitJob((await t.call('POST', `/projects/${pid}/research/batches`, { count: 2 })).json.job.id);
    assert.equal(job.state, 'failed', label);
    assert.match(job.error.message, expect, label);
    assert.equal((await t.call('GET', `/projects/${pid}/research/topics`)).json.ideas.length, 0, label);
  }
  // an answer that is valid JSON but contains nothing usable
  const t = boot();
  t.stub.answer(1, answer(topic('Nothing', { facts: [] })));
  t.stub.answer(2, 'I could not find anything');
  t.stub.answer(3, answer());
  const pid = await t.project();
  const job = await t.waitJob((await t.call('POST', `/projects/${pid}/research/batches`, { count: 2 })).json.job.id);
  assert.equal(job.state, 'failed');
  assert.match(job.error.message, /No usable topics/);
  assert.equal((await t.call('GET', `/projects/${pid}/research/topics`)).json.batches[0].state, 'failed');
});

test('cancelling mid-research stops Claude Code and keeps the topics already found (links unchecked)', async () => {
  const t = boot();
  t.stub.answer(1, answer(topic('Kept one'), topic('Kept two'), topic('Kept three'), topic('Kept four')));
  t.stub.sleeps(2); // the second run hangs until cancelled
  const pid = await t.project();
  const r = await t.call('POST', `/projects/${pid}/research/batches`, { count: 8 });
  const t0 = Date.now();
  while (t.stub.calls() < 2) {
    assert.ok(Date.now() - t0 < 15_000, 'second run never started');
    await new Promise((x) => setTimeout(x, 40));
  }
  assert.equal((await t.call('POST', `/jobs/${r.json.job.id}/cancel`)).status, 200);
  const job = await t.waitJob(r.json.job.id);
  assert.equal(job.state, 'cancelled');
  const { batches, ideas } = (await t.call('GET', `/projects/${pid}/research/topics`)).json;
  assert.equal(batches[0].state, 'cancelled');
  assert.match(batches[0].message, /Kept 4 topic/);
  assert.equal(ideas.length, 4);
  assert.ok(ideas.every((i: any) => i.links.unchecked === i.facts.length), 'links were not checked');
});

test('requests are validated: count must be a whole number from 1 to 20', async () => {
  const t = boot();
  const pid = await t.project();
  for (const count of [0, 21, 2.5, -1, 'many', null, undefined]) {
    assert.equal((await t.call('POST', `/projects/${pid}/research/batches`, { count })).status, 422, String(count));
    assert.equal((await t.call('POST', `/projects/${pid}/research/prompt`, { count })).status, 422, String(count));
  }
  assert.equal(t.stub.calls(), 0);
  assert.equal((await t.call('POST', '/projects/NOPE/research/batches', { count: 3 })).status, 404);
  assert.equal((await t.call('GET', '/projects/NOPE/research/topics')).status, 404);
  const ok = await t.call('POST', `/projects/${pid}/research/prompt`, { count: 20, focus: 'Mindanao' });
  assert.equal(ok.status, 200);
  assert.match(ok.json.prompt, /find 20 distinct/);
  assert.ok(!ok.json.prompt.includes('My secret project name'));
});

// ---------------- the copy-paste path ----------------
test('pasting an answer goes through the same validation and link checks', async () => {
  const t = boot();
  const pid = await t.project();
  const r = await t.call('POST', `/projects/${pid}/research/import`, { text: 'Here you go:\n```json\n' + answer(topic('Pasted one'), topic('Pasted two', { facts: [fact(1), { text: 'A fact with a dead link here.', source_url: 'https://gone.example.org/z' }] }), topic('Weak', { facts: [] })) + '\n```' });
  assert.equal(r.status, 201);
  assert.equal(r.json.source, 'manual');
  assert.equal(r.json.state, 'done');
  assert.deepEqual(r.json.rejected.map((x: any) => x.title), ['Weak']);
  const ideas = (await t.call('GET', `/projects/${pid}/research/topics`)).json.ideas;
  assert.deepEqual(ideas.map((i: any) => i.title).sort(), ['Pasted one', 'Pasted two']);
  assert.equal(ideas.find((i: any) => i.title === 'Pasted two').links.dead, 1);
  // duplicates of existing topics are skipped on a second paste
  const again = await t.call('POST', `/projects/${pid}/research/import`, { text: answer(topic('Pasted one')) });
  assert.equal(again.status, 422);
  assert.match(JSON.stringify(again.json.error.details), /duplicate/);
  for (const text of ['', '   ', 'no json here', '{"topics": "nope"}', undefined]) assert.equal((await t.call('POST', `/projects/${pid}/research/import`, { text })).status, text === 'no json here' || text === '{"topics": "nope"}' ? 502 : 422, String(text));
  assert.equal(t.stub.calls(), 0, 'the paste path never runs Claude Code');
});

// ---------------- using a topic ----------------
async function withIdeas() {
  const t = boot();
  const pid = await t.project('Source project', 'Superstitions');
  await t.call('POST', `/projects/${pid}/research/import`, { text: answer(topic('Topic A', { confidence: 'legend', note: 'Folk belief' }), topic('Topic B')) });
  const ideas = (await t.call('GET', `/projects/${pid}/research/topics`)).json.ideas as any[];
  return { ...t, pid, a: ideas.find((i) => i.title === 'Topic A'), b: ideas.find((i) => i.title === 'Topic B') };
}

test('using a topic fills this project\'s research with unverified claims, keeps history, and respects approval protection', async () => {
  const t = await withIdeas();
  const research = t.engine.list(t.pid, { kind: 'research' })[0];
  const used = await t.call('POST', `/topic-ideas/${t.a.id}/use`, {});
  assert.equal(used.status, 200);
  const content = (await t.call('GET', `/artifacts/${research.id}`)).json;
  assert.equal(content.state, 'in_progress');
  assert.equal(content.content.topic, 'Topic A');
  assert.equal(content.content.category, 'Superstitions');
  assert.ok(content.content.claims.every((c: any) => c.status === 'unverified'), 'AI research is never pre-verified');
  assert.match(content.content.notes, /Confidence: legend\. Folk belief/);
  assert.equal(t.engine.get(research.id).state, 'in_progress');
  assert.equal(JSON.parse(JSON.stringify((await t.call('GET', `/projects/${t.pid}/research/topics`)).json.ideas.find((i: any) => i.id === t.a.id))).status, 'used');

  // a second topic becomes a new version; the earlier notes stay in history
  assert.equal((await t.call('POST', `/topic-ideas/${t.b.id}/use`, {})).status, 200);
  assert.equal(t.engine.versions(research.id).length, 2);
  assert.equal((t.engine.getContent(research.id) as any).topic, 'Topic B');

  // approved research is protected
  const done = (r: any) => ({ ...r, checklist: r.checklist.map((c: any) => ({ ...c, done: true })) });
  t.engine.saveVersion(research.id, done(t.engine.getContent(research.id)));
  assert.equal((await t.call('POST', `/artifacts/${research.id}/submit`)).status, 200);
  assert.equal((await t.call('POST', `/artifacts/${research.id}/approve`, {})).status, 200);
  await t.call('POST', `/projects/${t.pid}/research/import`, { text: answer(topic('Topic C')) });
  const c = ((await t.call('GET', `/projects/${t.pid}/research/topics`)).json.ideas as any[]).find((i) => i.title === 'Topic C');
  const blocked = await t.call('POST', `/topic-ideas/${c.id}/use`, {});
  assert.equal(blocked.status, 409);
  assert.equal(t.engine.get(research.id).state, 'approved', 'approved research untouched');
  assert.equal((t.engine.getContent(research.id) as any).topic, 'Topic B');
  assert.equal((await t.call('POST', `/topic-ideas/${c.id}/use`, { reopen: true })).status, 200);
  assert.equal((t.engine.getContent(research.id) as any).topic, 'Topic C');
  assert.equal(t.engine.versions(research.id).some((v) => v.approved_at), true, 'the approved version is kept');
  assert.equal((await t.call('POST', '/topic-ideas/NOPE/use', {})).status, 404);
});

test('a topic can start a new project with the same category, languages and formats and its research filled in', async () => {
  const t = await withIdeas();
  const r = await t.call('POST', `/topic-ideas/${t.b.id}/new-project`, {});
  assert.equal(r.status, 201);
  const np = (await t.call('GET', `/projects/${r.json.projectId}`)).json;
  assert.equal(np.name, 'Topic B');
  assert.equal(np.category, 'Superstitions');
  assert.deepEqual(np.languages.sort(), ['en', 'tl']);
  assert.deepEqual(np.settings.formats, ['vertical_9x16']);
  const research = np.artifacts.find((a: any) => a.kind === 'research');
  assert.equal(research.state, 'in_progress');
  assert.equal((t.engine.getContent(research.id) as any).topic, 'Topic B');
  const used = ((await t.call('GET', `/projects/${t.pid}/research/topics`)).json.ideas as any[]).find((i) => i.id === t.b.id);
  assert.equal(used.status, 'used');
  assert.equal(t.engine.list(t.pid, { kind: 'research' })[0].state, 'not_started', 'the source project was not touched');
});

test('topics can be dismissed and restored; a used topic cannot', async () => {
  const t = await withIdeas();
  assert.equal((await t.call('POST', `/topic-ideas/${t.a.id}/dismiss`, {})).json.status, 'dismissed');
  assert.equal((await t.call('POST', `/topic-ideas/${t.a.id}/restore`, {})).json.status, 'new');
  await t.call('POST', `/topic-ideas/${t.a.id}/use`, {});
  assert.equal((await t.call('POST', `/topic-ideas/${t.a.id}/dismiss`, {})).status, 409);
});

test('topics are removed with their project and travel with a project archive', async () => {
  const t = await withIdeas();
  const arch = (await t.call('POST', `/projects/${t.pid}/archive`, {})).json;
  const restored = (await t.call('POST', '/archive/restore', { path: arch.path, as_copy: true })).json;
  const copy = (await t.call('GET', `/projects/${restored.projectId}/research/topics`)).json;
  assert.deepEqual(copy.ideas.map((i: any) => i.title).sort(), ['Topic A', 'Topic B']);
  assert.ok(copy.ideas.every((i: any) => i.project_id === restored.projectId && i.facts.length === 3));
  assert.ok(copy.batches.every((b: any) => b.project_id === restored.projectId));
  const del = await t.call('POST', `/projects/${t.pid}/delete`, { confirm_name: 'Source project' });
  assert.equal(del.status, 200);
  assert.equal((t.engine.db.prepare('SELECT COUNT(*) AS n FROM topic_ideas WHERE project_id = ?').get(t.pid) as { n: number }).n, 0);
  assert.equal((t.engine.db.prepare('SELECT COUNT(*) AS n FROM topic_batches WHERE project_id = ?').get(t.pid) as { n: number }).n, 0);
  assert.equal(((await t.call('GET', `/projects/${restored.projectId}/research/topics`)).json.ideas as any[]).length, 2, 'the restored copy is unaffected');
  assert.ok(!existsSync(join(t.root, 'cache')) || readdirSync(join(t.root, 'cache')).every((f) => !f.startsWith('trash_')));
});

// ---------------- Research Studio (no project) ----------------
test('Research Studio: research without any project, approve a topic, then start a video from it only when approved', async () => {
  const t = boot();
  t.stub.answer(1, answer(topic('Studio topic one'), topic('Studio topic two')));
  const r = await t.call('POST', '/studio/research/batches', { count: 2, category: 'Dark Folklore Horror', focus: 'Visayas' });
  assert.equal(r.status, 202);
  // wait for the run (no job row: it reports through the batch)
  for (let i = 0; i < 200; i++) {
    const b = (await t.call('GET', '/studio/research')).json.batches[0];
    if (b.state !== 'queued' && b.state !== 'running') break;
    await new Promise((x) => setTimeout(x, 40));
  }
  const list = (await t.call('GET', '/studio/research')).json;
  assert.equal(list.batches[0].state, 'done');
  assert.equal(list.batches[0].project_id, null);
  assert.equal(list.ideas.length, 2);
  assert.ok(list.ideas.every((i: any) => i.project_id === null && i.category === 'Dark Folklore Horror' && i.status === 'new' && i.approved_at === null), 'research never approves anything');
  assert.equal((await t.call('GET', '/projects')).json.length, 0, 'no project was created');
  assert.match(t.stub.read('prompt_1'), /Dark Folklore Horror/);
  assert.doesNotMatch(t.stub.read('prompt_1'), /secret|\/Users|@/, 'only the category, focus and count are sent');

  const [one] = list.ideas;
  // cannot start a video from a topic that is not approved
  assert.equal((await t.call('POST', `/topic-ideas/${one.id}/new-project`, {})).status, 409);
  const ap = await t.call('POST', `/topic-ideas/${one.id}/approve`);
  assert.equal(ap.status, 200);
  assert.equal(ap.json.status, 'approved');
  assert.ok(ap.json.approved_at);
  // a dismissed topic cannot be approved until restored
  const two = list.ideas[1];
  await t.call('POST', `/topic-ideas/${two.id}/dismiss`);
  assert.equal((await t.call('POST', `/topic-ideas/${two.id}/approve`)).status, 409);
  // an approved topic can be un-approved (restore)
  assert.equal((await t.call('POST', `/topic-ideas/${one.id}/restore`)).json.approved_at, null);
  await t.call('POST', `/topic-ideas/${one.id}/approve`);

  const np = await t.call('POST', `/topic-ideas/${one.id}/new-project`, { languages: ['en', 'tl'], formats: ['vertical_9x16'] });
  assert.equal(np.status, 201);
  const p = (await t.call('GET', `/projects/${np.json.projectId}`)).json;
  assert.equal(p.name, one.title);
  assert.equal(p.category, 'Dark Folklore Horror');
  assert.deepEqual(p.languages, ['en', 'tl']);
  const research = p.artifacts.find((a: any) => a.kind === 'research');
  assert.equal(research.state, 'in_progress', 'the project gets the notes but the topic still needs approval in the project');
  const started = (await t.call('GET', '/studio/research')).json.ideas.find((i: any) => i.id === one.id);
  assert.equal(started.status, 'used');
  assert.equal(started.video_project_id, np.json.projectId, 'the topic links to its video');
  assert.equal((await t.call('POST', `/projects/${np.json.projectId}/delete`, { confirm_name: p.name })).status, 200);
  const back = (await t.call('GET', '/studio/research')).json.ideas.find((i: any) => i.id === one.id);
  assert.equal(back.status, 'approved', 'deleting the video makes the topic available again');
  assert.equal(back.video_project_id, null);
  // a studio topic cannot be pushed into a project via "use"
  assert.equal((await t.call('POST', `/topic-ideas/${two.id}/use`, {})).status, 422);
});

test('Research Studio: one run at a time, cancel keeps what was found, restart marks stuck runs failed, paste import works with no project', async () => {
  const t = boot();
  t.stub.sleeps(1);
  const r = await t.call('POST', '/studio/research/batches', { count: 3, category: 'Geography' });
  assert.equal(r.status, 202);
  assert.equal((await t.call('POST', '/studio/research/batches', { count: 1 })).status, 409, 'a second run is refused while one is going');
  await new Promise((x) => setTimeout(x, 400));
  const c = await t.call('POST', `/studio/research/batches/${r.json.id}/cancel`);
  assert.equal(c.status, 200);
  for (let i = 0; i < 200; i++) {
    if ((await t.call('GET', '/studio/research')).json.batches[0].state === 'cancelled') break;
    await new Promise((x) => setTimeout(x, 40));
  }
  assert.equal((await t.call('GET', '/studio/research')).json.batches[0].state, 'cancelled');
  assert.equal((await t.call('POST', `/studio/research/batches/${r.json.id}/cancel`)).status, 409);
  assert.equal((await t.call('POST', '/studio/research/batches', { count: 0 })).status, 422);
  assert.equal((await t.call('POST', '/studio/research/batches', { count: 21 })).status, 422);

  const imp = await t.call('POST', '/studio/research/import', { text: answer(topic('Pasted studio topic')), category: 'Food Origins' });
  assert.equal(imp.status, 201);
  const idea = (await t.call('GET', '/studio/research')).json.ideas.find((i: any) => i.title === 'Pasted studio topic');
  assert.equal(idea.category, 'Food Origins');
  assert.equal(idea.project_id, null);
  assert.match((await t.call('POST', '/studio/research/prompt', { count: 3, category: 'Geography' })).json.prompt, /"Geography"/);
});
