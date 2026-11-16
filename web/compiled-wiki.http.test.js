'use strict';

// SSE checks for the compiled_wiki 导读. Requests are answer-cache hits, so
// they must not start the daemon or call the LLM.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.LLM_MODEL = 'cache-test-model';
process.env.SEMANTIC_CACHE = 'false';
process.env.RATE_LIMIT_ASK = '1000';
delete process.env.COMPILED_WIKI;
process.env.EDK2_TRACE_FILE = path.join(os.tmpdir(), `edk2-compiled-wiki-${process.pid}.jsonl`);

console.log = () => {};
console.error = () => {};

const { server, answerCache, setCompiledPages } = require('./server');
const {
  loadCompiledWiki,
  defaultCompiledWikiDir,
  matchCompiledWiki,
  pageFromMarkdown,
  stampCacheMeta,
  compiledWikiGuide,
  COMPILED_WIKI_EVENT,
} = require('./compiled-wiki');

const MODEL = 'cache-test-model';

function listenPort() {
  if (server.listening) return Promise.resolve(server.address().port);
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function ask(port, question) {
  const data = JSON.stringify({ question, history: [], prevResults: [] });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/ask',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(4000, () => req.destroy(new Error('timed out; cache miss likely called the daemon or LLM')));
    req.on('error', reject);
    req.end(data);
  });
}

function parseSSE(body) {
  const events = [];
  for (const block of body.split(/\n\n/)) {
    if (!block.trim()) continue;
    const em = /^event:\s*(\S+)/m.exec(block);
    const dm = /^data:\s*(.+)$/m.exec(block);
    if (!em || !dm) continue;
    events.push({ event: em[1], data: JSON.parse(dm[1]) });
  }
  return events;
}

function tiePage(id) {
  return pageFromMarkdown(`---
id: ${id}
title: ${id}
topic: driver-binding
canonical: ${id}
aliases:
  - zz shared alias phrase
sense: >-
  sense ${id}
distinguishes_from:
  - id: other-${id}
    canonical: OTHER_${id}
    aliases:
      - alias dump ${id}
    source_paths:
      - source: tianocore-docs
        file: edk2-UefiDriverWritersGuide/${id}-other.md
source_paths:
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/${id}.md
    url: https://example.invalid/${id}
---
SECRET_BODY_${id}
`, `${id}.md`);
}

test('compiled_wiki SSE guide is one event on a hit and absent otherwise', async () => {
  const port = await listenPort();
  const realPages = setCompiledPages([]);
  setCompiledPages(realPages);
  const savedFlag = process.env.COMPILED_WIKI;
  try {
    const hit = matchCompiledWiki('driver binding version', realPages);
    assert.ok(hit);
    const expected = compiledWikiGuide(hit);
    const seeded = [{ title: 'cached-only', file: 'not-a-wiki-path.md', snippet: 'cached' }];
    answerCache.store('driver binding version', MODEL, stampCacheMeta({
      answer: '缓存回答，不含编译页正文。',
      results: seeded,
      tokens: 4,
      model: MODEL,
    }, hit, { enabled: true }));

    const hitRes = await ask(port, 'driver binding version');
    assert.equal(hitRes.status, 200);
    const events = parseSSE(hitRes.body);
    const guides = events.filter((e) => e.event === COMPILED_WIKI_EVENT);
    assert.equal(guides.length, 1);
    assert.equal(COMPILED_WIKI_EVENT, 'compiled_wiki');
    assert.deepEqual(guides[0].data, expected);
    assert.equal(JSON.stringify(guides[0].data).includes('不引用本页'), false);
    assert.equal(hitRes.body.includes('不引用本页'), false);
    assert.equal(hitRes.body.includes('tianocore-docs.github.io'), false);
    assert.equal(hitRes.body.includes('FirmwareVersion'), false);
    const results = events.filter((e) => e.event === 'results');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].data.results, seeded);
    assert.equal(JSON.stringify(results[0].data).includes('3141_connectcontroller'), false);
    assert.ok(events.findIndex((e) => e.event === 'compiled_wiki') < events.findIndex((e) => e.event === 'results'));

    answerCache.store('zzzz unique miss phrase', MODEL, {
      answer: '没有编译页。',
      results: seeded,
      tokens: 2,
      model: MODEL,
    });
    const miss = await ask(port, 'zzzz unique miss phrase');
    assert.equal(miss.status, 200);
    assert.equal(parseSSE(miss.body).filter((e) => e.event === 'compiled_wiki').length, 0);
    assert.match(miss.body, /没有编译页/);

    const pages = [tiePage('alpha-sense'), tiePage('beta-sense')];
    assert.equal(pages.length, 2);
    assert.equal(matchCompiledWiki('zz shared alias phrase', pages), null);
    setCompiledPages(pages);
    answerCache.store('zz shared alias phrase', MODEL, {
      answer: '别名冲突，不算命中。',
      results: seeded,
      tokens: 2,
      model: MODEL,
    });
    const tie = await ask(port, 'zz shared alias phrase');
    assert.equal(tie.status, 200);
    assert.equal(parseSSE(tie.body).filter((e) => e.event === 'compiled_wiki').length, 0);
    assert.equal(tie.body.includes('SECRET_BODY_'), false);
    assert.equal(tie.body.includes('example.invalid'), false);
    assert.match(tie.body, /别名冲突/);
    setCompiledPages(realPages);

    process.env.COMPILED_WIKI = 'false';
    const off = await ask(port, 'driver binding version');
    assert.equal(off.status, 200);
    assert.equal(parseSSE(off.body).filter((e) => e.event === 'compiled_wiki').length, 0);
    assert.match(off.body, /缓存回答/);
    assert.ok(matchCompiledWiki('driver binding version', realPages));
  } finally {
    setCompiledPages(realPages);
    if (savedFlag == null) delete process.env.COMPILED_WIKI;
    else process.env.COMPILED_WIKI = savedFlag;
  }
});

test('loaded seed pages are the ones the guide is built from', () => {
  const pages = loadCompiledWiki(defaultCompiledWikiDir());
  assert.equal(pages.some((p) => p.id === 'driver-binding-version'), true);
});

test.after(() => new Promise((resolve) => server.close(() => resolve())));
