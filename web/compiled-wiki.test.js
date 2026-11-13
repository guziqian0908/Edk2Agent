'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAnswerCache } = require('./similar-cache');
const { selectFocusQueries, mergeRetrievalPool } = require('./retrieval-routing');
const {
  compiledWikiEnabled,
  defaultCompiledWikiDir,
  loadCompiledWiki,
  pageFromMarkdown,
  matchCompiledWiki,
  normalizePhrase,
  sourcePathAnchors,
  downrankFiles,
  cacheReplayAllowed,
  stampCacheMeta,
  routingText,
  relationalExpansionHint,
  dropExcludedQueries,
  neighborSeeds,
  considerCachedAnswer,
} = require('./compiled-wiki');

const WIKI = defaultCompiledWikiDir();
const DRIVER_FILES = [
  '91_driver_binding_protocol_implementations.md',
  '3141_connectcontroller.md',
  '3142_loading_uefi_option_rom_drivers.md',
];

function writePage(dir, name, body) {
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pages', name), body);
}

test('normalize keeps digits and dots in section numbers', () => {
  assert.equal(normalizePhrase('see 9.1 and 3.14.1 now'), 'see 9.1 and 3.14.1 now');
  assert.equal(normalizePhrase('Driver  Binding\tVersion'), 'driver binding version');
});

test('missing or empty directory loads as disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-wiki-'));
  assert.deepEqual(loadCompiledWiki(dir), []);
  assert.deepEqual(loadCompiledWiki(path.join(dir, 'nope')), []);
  assert.equal(matchCompiledWiki('driver binding version', []), null);
});

test('flag disables matching for false, 0, off, and no', () => {
  assert.equal(compiledWikiEnabled({}), true);
  assert.equal(compiledWikiEnabled({ COMPILED_WIKI: '' }), true);
  for (const v of ['false', 'FALSE', '0', 'off', 'no', ' No ']) {
    assert.equal(compiledWikiEnabled({ COMPILED_WIKI: v }), false, v);
  }
  assert.equal(compiledWikiEnabled({ COMPILED_WIKI: 'true' }), true);
});

test('real seed pages load, and driver binding version hits the Version field', () => {
  const pages = loadCompiledWiki(WIKI);
  const ids = pages.map((p) => p.id).sort();
  assert.deepEqual(ids, [
    'boot-services',
    'driver-binding-version',
    'event-tpl',
    'hob',
    'ppi',
    'runtime-services',
    'secure-boot',
  ]);
  for (const q of [
    'driver binding version',
    'uefi driver binding version 可以用来做什么',
  ]) {
    const hit = matchCompiledWiki(q, pages);
    assert.ok(hit, q);
    assert.equal(hit.id, 'driver-binding-version');
    assert.equal(hit.canonical, 'EFI_DRIVER_BINDING_PROTOCOL.Version');
    assert.match(hit.sense, /ConnectController/);
    const files = hit.source_paths.map((p) => p.file);
    for (const name of DRIVER_FILES) {
      assert.ok(files.some((f) => f.endsWith(name)), name);
    }
    assert.ok(hit.source_paths.length >= 1);
    const blob = JSON.stringify({
      canonical: hit.canonical,
      sense: hit.sense,
      aliases: hit.aliases,
      title: hit.title,
    });
    assert.equal(blob.includes('Driver Supported EFI Version Protocol'), false);
    const distinguished = JSON.stringify(hit.distinguishes_from);
    assert.equal(distinguished.includes('Driver Supported EFI Version Protocol'), true);
    assert.equal(distinguished.includes('16_driver_supported_efi_version_protocol'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(hit, 'body'), false);
    const raw = fs.readFileSync(path.join(WIKI, 'pages', 'driver-binding-version.md'), 'utf8');
    const body = raw.split(/^---\s*$/m).slice(2).join('---');
    assert.match(body, /3\.14\.1/);
    assert.match(body, /不引用本页/);
    assert.equal(JSON.stringify(hit).includes('不引用本页'), false);
    assert.equal(JSON.stringify(hit).includes(body.trim()), false);
  }
});

test('a lone generic token does not force a sense', () => {
  const pages = loadCompiledWiki(WIKI);
  assert.equal(matchCompiledWiki('version', pages), null);
  assert.equal(matchCompiledWiki('boot', pages), null);
  assert.equal(matchCompiledWiki('event', pages), null);
  const tpl = matchCompiledWiki('TPL', pages);
  assert.equal(tpl && tpl.id, 'event-tpl');
  assert.equal(matchCompiledWiki('PPI', pages).id, 'ppi');
  assert.equal(matchCompiledWiki('HOB', pages).id, 'hob');
});

test('equal longest alias across pages is a miss', () => {
  const page = (id, alias) => `---
id: ${id}
title: ${id}
topic: driver-binding
canonical: ${id}
aliases:
  - ${alias}
sense: >-
  sense ${id}
source_paths:
  - source: tianocore-docs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/${id}.md
---
body ${id} must not be returned
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-wiki-tie-'));
  writePage(dir, 'a.md', page('alpha-sense', 'driver binding version'));
  writePage(dir, 'b.md', page('beta-sense', 'driver binding version'));
  const pages = loadCompiledWiki(dir);
  assert.equal(pages.length, 2);
  assert.equal(matchCompiledWiki('uefi driver binding version', pages), null);
  writePage(dir, 'c.md', page('gamma-sense', 'driver binding protocol version field'));
  const longer = matchCompiledWiki('driver binding protocol version field', loadCompiledWiki(dir));
  assert.equal(longer && longer.id, 'gamma-sense');
  assert.equal(JSON.stringify(longer).includes('must not be returned'), false);
});

test('a page without source_paths is not a hit', () => {
  const text = `---
id: empty-paths
title: empty
topic: driver-binding
canonical: NOTHING
aliases:
  - totally unique phrase
sense: >-
  no path
source_paths: []
---
`;
  assert.equal(pageFromMarkdown(text, 'empty.md'), null);
});

test('cache replays only the same id and the same source file set', () => {
  const pages = loadCompiledWiki(WIKI);
  const match = matchCompiledWiki('driver binding version', pages);
  const files = match.source_paths.map((p) => p.file);
  const old = { answer: 'old', compiledId: undefined, compiledFiles: undefined };
  assert.equal(cacheReplayAllowed(old, match, { enabled: true }), false);
  assert.equal(cacheReplayAllowed({ answer: 'x' }, match, { enabled: true }), false);
  assert.equal(cacheReplayAllowed({
    compiledId: match.id,
    compiledFiles: files,
  }, match, { enabled: true }), true);
  assert.equal(cacheReplayAllowed({
    compiledId: 'other',
    compiledFiles: files,
  }, match, { enabled: true }), false);
  assert.equal(cacheReplayAllowed({
    compiledId: match.id,
    compiledFiles: files.slice(1),
  }, match, { enabled: true }), false);
  assert.equal(cacheReplayAllowed(old, match, { enabled: false }), true);
  assert.equal(cacheReplayAllowed(old, null, { enabled: true }), true);

  const stamped = stampCacheMeta({ answer: 'new' }, match, { enabled: true });
  assert.equal(stamped.compiledId, match.id);
  assert.deepEqual(stamped.compiledFiles, [...files].sort());
  const plain = stampCacheMeta({ answer: 'new' }, match, { enabled: false });
  assert.equal(plain.compiledId, undefined);

  const cache = createAnswerCache();
  cache.store('driver binding version', 'm', { answer: 'stale' });
  assert.equal(considerCachedAnswer(cache, 'driver binding version', 'm', match, { enabled: true }), null);
  cache.store('driver binding version', 'm', stampCacheMeta({ answer: 'fresh' }, match, { enabled: true }));
  const replay = considerCachedAnswer(cache, 'driver binding version', 'm', match, { enabled: true });
  assert.equal(replay && replay.entry.answer, 'fresh');
  assert.equal(replay.match, 'exact');
  const off = considerCachedAnswer(cache, 'driver binding version', 'm', match, { enabled: false });
  assert.equal(off && off.entry.answer, 'fresh');
});

test('source path anchors outrank focus and docs, and the other protocol is downranked', () => {
  const pages = loadCompiledWiki(WIKI);
  const match = matchCompiledWiki('driver binding version', pages);
  const anchors = sourcePathAnchors(match);
  const down = downrankFiles(match).map((f) => f.toLowerCase());
  const connect = match.source_paths.find((p) => p.file.endsWith('3141_connectcontroller.md')).file;
  const impl = match.source_paths.find((p) => p.file.endsWith('91_driver_binding_protocol_implementations.md')).file;
  const rom = match.source_paths.find((p) => p.file.endsWith('3142_loading_uefi_option_rom_drivers.md')).file;
  const wrong = down[0];
  const pool = mergeRetrievalPool({
    question: 'uefi driver binding version 可以用来做什么',
    anchors,
    downrank: down,
    focus: [{ title: 'focus chapter', file: 'focus/other.md', text: 'focus', source: 'tianocore-docs' }],
    docs: [{ title: 'docs chapter', file: 'docs/other.md', text: 'docs', source: 'tianocore-docs' }],
    broad: [
      { title: 'Driver Supported EFI Version Protocol', file: wrong, text: 'wrong sense', source: 'tianocore-docs' },
      { title: 'ConnectController', file: connect, text: 'priority', source: 'tianocore-docs' },
      { title: 'implementations', file: impl, text: 'version field', source: 'tianocore-docs' },
      { title: 'option rom', file: rom, text: '0x10', source: 'tianocore-docs' },
    ],
  }, { enabled: true });
  const order = pool.map((r) => r.file);
  assert.ok(order.indexOf(connect) < order.indexOf('focus/other.md'));
  assert.ok(order.indexOf(impl) < order.indexOf('docs/other.md'));
  assert.ok(order.indexOf(rom) < order.indexOf(wrong));
  assert.ok(order.indexOf(connect) < order.indexOf(wrong));
});

test('routing and relational expansion use canonical and sense, not the confounder', () => {
  const pages = loadCompiledWiki(WIKI);
  const q = 'uefi driver binding version 和 secure boot 有什么关系';
  const match = matchCompiledWiki(q, pages);
  assert.equal(match.id, 'driver-binding-version');
  const text = routingText(q, match);
  assert.equal(text.includes('secure boot'), false);
  assert.match(text, /EFI_DRIVER_BINDING_PROTOCOL\.Version/);
  assert.match(text, /ConnectController/);
  const focus = selectFocusQueries(text, { blob: text, enabled: true });
  const qs = focus.map((item) => item.q).join('\n');
  assert.match(qs, /Driver Binding/);
  assert.doesNotMatch(qs, /Secure Boot chain/);
  const hint = relationalExpansionHint(match);
  assert.match(hint.subject, /EFI_DRIVER_BINDING_PROTOCOL\.Version/);
  assert.ok(hint.exclude.some((p) => /Driver Supported EFI Version Protocol/i.test(p)));
  const kept = dropExcludedQueries([
    'ConnectController driver binding connection priority',
    'Driver Supported EFI Version Protocol supported version',
  ], hint.exclude);
  assert.deepEqual(kept, ['ConnectController driver binding connection priority']);
});

test('directory neighbors stay on the original source files', () => {
  const pages = loadCompiledWiki(WIKI);
  const match = matchCompiledWiki('driver binding version', pages);
  const connect = match.source_paths.find((p) => p.file.endsWith('3141_connectcontroller.md')).file;
  const seeds = neighborSeeds([
    { file: 'edk2-kb/compiled-wiki/pages/driver-binding-version.md', title: 'compiled' },
    { file: connect, title: 'ConnectController' },
    { file: 'somewhere/else.md', title: 'else' },
  ], match);
  assert.deepEqual(seeds.map((r) => r.file), [connect]);
  const untouched = [{ file: 'a.md' }, { file: 'b.md' }];
  assert.equal(neighborSeeds(untouched, null), untouched);
});
