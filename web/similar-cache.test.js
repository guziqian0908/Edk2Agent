'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAnswerCache,
  isFollowUpQuestion,
  lexicalScore,
  indexQuestion,
} = require('./similar-cache');

function cache(extra = {}) {
  let now = 1_000_000;
  const c = createAnswerCache({
    max: 3,
    ttlMs: 1000,
    now: () => now,
    lexicalEnabled: true,
    ...extra,
  });
  return {
    c,
    advance(ms) { now += ms; },
  };
}

test('exact hit replays the stored answer and ignores case/extra spaces', () => {
  const { c } = cache();
  c.store('PCD 是什么', 'glm', { answer: 'A', results: [], tokens: 3 });
  const hit = c.getExact('  pcd   是什么 ', 'glm');
  assert.equal(hit.answer, 'A');
  assert.equal(hit.hitCount, 1);
  assert.equal(c.getExact('PCD是什么', 'glm'), null);
});

test('lexical tier matches punctuation, spacing, and common paraphrases', () => {
  const { c } = cache();
  c.store('PCD 有哪些类型', 'glm', { answer: 'types', results: [1], tokens: 4 });
  const spaced = c.getLexical('PCD有哪些类型?', 'glm');
  assert.ok(spaced);
  assert.equal(spaced.entry.answer, 'types');
  assert.equal(spaced.similarity, 1);

  c.store('什么是 PCD', 'glm', { answer: 'def', results: [], tokens: 2 });
  const flipped = c.getLexical('PCD 是什么？', 'glm');
  assert.ok(flipped);
  assert.equal(flipped.entry.answer, 'def');

  c.store('EDK2 如何提交代码', 'glm', { answer: 'commit', results: [], tokens: 5 });
  const synonym = c.getLexical('EDK2怎么提交代码', 'glm');
  assert.ok(synonym);
  assert.equal(synonym.entry.answer, 'commit');
});

test('lexical tier does not cross different identifiers or unrelated questions', () => {
  const { c } = cache();
  c.store('如何编写 INF 文件', 'glm', { answer: 'inf', results: [], tokens: 3 });
  assert.equal(c.getLexical('如何编写 DEC 文件', 'glm'), null);
  assert.equal(c.getLexical('什么是 Depex', 'glm'), null);

  c.store('什么是 PCD', 'glm', { answer: 'pcd', results: [], tokens: 2 });
  assert.equal(c.getLexical('什么是 Depex', 'glm'), null);
  assert.equal(c.getLexical('如何提交补丁', 'glm'), null);

  const score = lexicalScore(
    indexQuestion('如何提交代码'),
    indexQuestion('如何提交补丁'),
    c.cfg,
  );
  assert.equal(score, 0);
});

test('polite wrapper still hits; a much longer different question does not', () => {
  const { c } = cache();
  c.store('什么是 PCD', 'glm', { answer: 'pcd', results: [], tokens: 2 });
  const polite = c.getLexical('请问什么是 PCD 呢', 'glm');
  assert.ok(polite);
  assert.equal(polite.entry.answer, 'pcd');
  assert.equal(c.getLexical('不是什么是 PCD', 'glm'), null);
  assert.equal(
    c.getLexical('请问 ACPI 表和 UEFI 启动流程分别是什么', 'glm'),
    null,
  );
});

test('different models do not share entries', () => {
  const { c } = cache();
  c.store('什么是 PCD', 'glm', { answer: 'glm-answer', results: [], tokens: 1 });
  assert.equal(c.getExact('什么是 PCD', 'deepseek'), null);
  assert.equal(c.getLexical('PCD 是什么', 'deepseek'), null);
});

test('TTL expiry and fresh overwrite', () => {
  const box = cache();
  box.c.store('什么是 PCD', 'glm', { answer: 'old', results: [], tokens: 1 });
  box.advance(1000);
  assert.equal(box.c.getExact('什么是 PCD', 'glm'), null);
  assert.equal(box.c.getLexical('PCD是什么', 'glm'), null);

  box.c.store('什么是 PCD', 'glm', { answer: 'v1', results: [], tokens: 1 });
  box.c.store('什么是 PCD', 'glm', { answer: 'v2', results: [], tokens: 1 });
  assert.equal(box.c.getExact('什么是 PCD', 'glm').answer, 'v2');
});

test('LRU evicts the oldest entry', () => {
  const { c } = cache({ max: 2 });
  c.store('问题一 PCD', 'glm', { answer: '1', results: [], tokens: 1 });
  c.store('问题二 Depex', 'glm', { answer: '2', results: [], tokens: 1 });
  c.store('问题三 INF', 'glm', { answer: '3', results: [], tokens: 1 });
  assert.equal(c.getExact('问题一 PCD', 'glm'), null);
  assert.equal(c.getExact('问题三 INF', 'glm').answer, '3');
});

test('semantic tier reuses a near embedding and rejects a weak one', () => {
  const { c } = cache({ semanticThreshold: 0.93 });
  const entry = c.store('什么是 PCD', 'glm', { answer: 'pcd', results: [], tokens: 2 });
  c.attachEmbedding(entry, [1, 0, 0]);
  const hit = c.bestSemantic([0.96, 0.28, 0], 'glm');
  assert.ok(hit);
  assert.equal(hit.entry.answer, 'pcd');
  assert.ok(hit.similarity > 0.93);
  assert.equal(c.bestSemantic([0.5, 0.5, 0.7071], 'glm'), null);
  assert.equal(c.bestSemantic([1, 0, 0], 'other-model'), null);
});

test('SIMILAR_CACHE can disable the lexical tier without dropping exact hits', () => {
  const { c } = cache({ lexicalEnabled: false });
  c.store('什么是 PCD', 'glm', { answer: 'pcd', results: [], tokens: 1 });
  assert.equal(c.getLexical('PCD 是什么', 'glm'), null);
  assert.equal(c.getExact('什么是 PCD', 'glm').answer, 'pcd');
});

test('follow-up detector keeps anaphora out and lets real questions through', () => {
  assert.equal(isFollowUpQuestion('详细说说'), true);
  assert.equal(isFollowUpQuestion('继续'), true);
  assert.equal(isFollowUpQuestion('上面那个协议呢'), true);
  assert.equal(isFollowUpQuestion('它和 PCD 的区别'), true);
  assert.equal(isFollowUpQuestion('tell me more about that'), true);
  assert.equal(isFollowUpQuestion(''), true);
  assert.equal(isFollowUpQuestion('如何编写 INF 文件'), false);
  assert.equal(isFollowUpQuestion('为什么 PCD 要分成几种类型'), false);
  assert.equal(isFollowUpQuestion('PCD'), false);
  assert.equal(isFollowUpQuestion('其他模块怎么链接'), false);
});
