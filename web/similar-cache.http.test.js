'use strict';

// Boots web/server.js on an ephemeral port and checks that a seeded answer is
// replayed for an exact repeat and a near-duplicate, including when the client
// sends history (the browser always does). These requests must not reach the
// daemon: a miss would try to start it and the request would time out.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.LLM_MODEL = 'cache-test-model';
process.env.SEMANTIC_CACHE = 'false';
process.env.EDK2_TRACE_FILE = path.join(os.tmpdir(), `edk2-similar-cache-${process.pid}.jsonl`);

// server.js logs to stdout on load; keep that off the TAP stream.
console.log = () => {};
console.error = () => {};

const { server, answerCache } = require('./server');

function listenPort() {
  if (server.listening) return Promise.resolve(server.address().port);
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function ask(port, payload) {
  const data = JSON.stringify(payload);
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
    req.setTimeout(4000, () => req.destroy(new Error('timed out; cache miss likely called the daemon')));
    req.on('error', reject);
    req.end(data);
  });
}

function doneEvent(body) {
  const m = /event: done\r?\ndata: (.*)/.exec(body);
  assert.ok(m, `missing done event:\n${body.slice(0, 400)}`);
  return JSON.parse(m[1]);
}

test('HTTP replay skips retrieval for exact and similar questions with history', async () => {
  const port = await listenPort();
  answerCache.store('PCD 有哪些类型', 'cache-test-model', {
    answer: '固定 PCD、动态 PCD。',
    results: [{ title: 'PCD', snippet: 'types' }],
    tokens: 6,
    model: 'cache-test-model',
  });
  const history = [
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '之前的回答' },
  ];
  const prevResults = [{ turn: 1, results: [{ title: 'old' }] }];

  const exact = await ask(port, {
    question: 'pcd  有哪些类型',
    history,
    prevResults,
  });
  assert.equal(exact.status, 200);
  const exactDone = doneEvent(exact.body);
  assert.equal(exactDone.from_cache, true);
  assert.equal(exactDone.cache_match, 'exact');
  assert.equal(exactDone.searchCalls, 0);
  assert.match(exact.body, /固定 PCD/);
  assert.doesNotMatch(exact.body, /正在检索知识库/);

  const similar = await ask(port, {
    question: '请问PCD有哪几种类型？',
    history,
    prevResults,
  });
  assert.equal(similar.status, 200);
  const similarDone = doneEvent(similar.body);
  assert.equal(similarDone.from_cache, true);
  assert.equal(similarDone.cache_match, 'lexical');
  assert.equal(similarDone.searchCalls, 0);
  assert.equal(similarDone.similarity, 1);
  assert.match(similar.body, /命中相似问题缓存/);
  assert.match(similar.body, /固定 PCD/);
  assert.doesNotMatch(similar.body, /正在检索知识库/);
});

test.after(() => new Promise((resolve) => server.close(() => resolve())));
