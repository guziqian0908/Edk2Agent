'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ANALYZE_SYSTEM_TRANSLATE,
  ANALYZE_SYSTEM_DECOMPOSE,
  ANALYZE_SYSTEM_PARAPHRASE,
  RELATIONAL_QUERY_CAP,
  RELATIONAL_SOURCE,
  relationalExpansionEnabled,
  buildAnalysisSystemPrompt,
  normalizeRelatedQueries,
  relatedQueriesForSearch,
  parseAnalysisPayload,
  selectRelationalHits,
  planDirectoryNeighbors,
  maybeExpandDirectoryNeighbors,
} = require('./retrieval-expansion');

const REPO = 'edk2-UefiDriverWritersGuide';
const CONNECT = `${REPO}/3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md`;
const OPTION_ROM = `${REPO}/3_foundation/314_uefi_driver_model_connection_process/3142_loading_uefi_option_rom_drivers.md`;
const DISCONNECT = `${REPO}/3_foundation/314_uefi_driver_model_connection_process/3143_disconnectcontroller.md`;
const BINDING = `${REPO}/9_driver_binding_protocol/91_driver_binding_protocol_implementations.md`;
const DEBUGLIB = `${REPO}/31_testing/314_debugging/3141_configuring_debuglib_with_edk_ii.md`;

// Indent is intentionally flat for 3.14.x, matching the published GitBook
// SUMMARY: directory, not leading spaces, is what groups 3141 with 3142.
const SUMMARY = `
# Summary
* [3 Foundation](3_foundation/README.md)
 * [3.14 UEFI Driver Model Connection Process](3_foundation/314_uefi_driver_model_connection_process/README.14.md)
 * [3.14.1 ConnectController()](3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md)
 * [3.14.2 Loading UEFI option ROM drivers](3_foundation/314_uefi_driver_model_connection_process/3142_loading_uefi_option_rom_drivers.md)
 * [3.14.3 DisconnectController()](3_foundation/314_uefi_driver_model_connection_process/3143_disconnectcontroller.md)
* [9 Driver Binding Protocol](9_driver_binding_protocol/README.md)
 * [9.1 Driver Binding Protocol Implementations](9_driver_binding_protocol/91_driver_binding_protocol_implementations.md)
 * [9.2 Driver Binding Protocol Template](9_driver_binding_protocol/92_driver_binding_protocol_template.md)
* [16 Driver Supported EFI Version Protocol](16_driver_supported_efi_version_protocol/README.md)
 * [16.1 Implementation](16_driver_supported_efi_version_protocol/161_impl.md)
 * [31.4.1 Configuring DebugLib](31_testing/314_debugging/3141_configuring_debuglib_with_edk_ii.md)
`;

const TRANSLATION = 'What can the UEFI driver binding version be used for';

function doc(file, extra = {}) {
  return { source: 'tianocore-docs', file, title: file, content: 'body', ...extra };
}

test('RELATIONAL_QUERY_EXPANSION defaults on and accepts the false spellings', () => {
  assert.equal(relationalExpansionEnabled({}), true);
  assert.equal(relationalExpansionEnabled({ RELATIONAL_QUERY_EXPANSION: '' }), true);
  assert.equal(relationalExpansionEnabled({ RELATIONAL_QUERY_EXPANSION: 'true' }), true);
  assert.equal(relationalExpansionEnabled({ RELATIONAL_QUERY_EXPANSION: 'false' }), false);
  assert.equal(relationalExpansionEnabled({ RELATIONAL_QUERY_EXPANSION: '0' }), false);
  assert.equal(relationalExpansionEnabled({ RELATIONAL_QUERY_EXPANSION: 'off' }), false);
  assert.equal(relationalExpansionEnabled({ RELATIONAL_QUERY_EXPANSION: 'no' }), false);
  assert.equal(relationalExpansionEnabled({ FOCUS_TOPIC_ROUTING: 'false' }), true);
});

test('rollback keeps the old analysis prompts and drops related queries', () => {
  assert.equal(buildAnalysisSystemPrompt({}), ANALYZE_SYSTEM_TRANSLATE);
  assert.equal(buildAnalysisSystemPrompt({ decompose: true }), ANALYZE_SYSTEM_DECOMPOSE);
  assert.equal(buildAnalysisSystemPrompt({ paraphrase: true }), ANALYZE_SYSTEM_PARAPHRASE);
  assert.equal(buildAnalysisSystemPrompt({}).includes('related_queries'), false);

  const on = buildAnalysisSystemPrompt({ relational: true });
  assert.match(on, /related_queries/);
  assert.match(on, /2 or 3/);
  assert.doesNotMatch(on, /3-4|3–4/);
  const decomposed = buildAnalysisSystemPrompt({ decompose: true, relational: true });
  assert.match(decomposed, /Decompose the question/);
  assert.match(decomposed, /related_queries/);
  assert.match(decomposed, /not copies of sub_queries/);

  const analysis = {
    translation: TRANSLATION,
    relatedQueries: [
      'ConnectController priority ordering',
      'Driver Binding Protocol Version field',
    ],
  };
  assert.deepEqual(relatedQueriesForSearch(analysis, { RELATIONAL_QUERY_EXPANSION: 'false' }), []);
  assert.deepEqual(normalizeRelatedQueries(analysis.relatedQueries, { enabled: false, translation: TRANSLATION }), []);
});

test('related queries stay at 2-3, drop paraphrases, and keep the vocabulary bridge', () => {
  const raw = [
    'What is the UEFI driver binding version used for',
    'Driver Binding Protocol Version field',
    'ConnectController priority ordering',
    'driver connection precedence',
    'another completely different boot service facet',
    '版本字段',
    '',
    12,
  ];
  const out = normalizeRelatedQueries(raw, { translation: TRANSLATION });
  assert.equal(RELATIONAL_QUERY_CAP, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(out, [
    'Driver Binding Protocol Version field',
    'ConnectController priority ordering',
    'driver connection precedence',
  ]);
  assert.equal(out.some((q) => /what is the uefi driver binding version/i.test(q)), false);

  const parsed = parseAnalysisPayload(
    '```json\n{"translation":"Driver Binding Version field","sub_queries":["ignore me"],"related_queries":["ConnectController priority ordering","driver connection precedence"]}\n```',
    '原始问题',
    { structured: true, plainOk: true },
  );
  assert.equal(parsed.translation, 'Driver Binding Version field');
  assert.equal(parsed.subQueries.length, 1);
  const searched = relatedQueriesForSearch(parsed, {});
  assert.ok(searched.includes('ConnectController priority ordering'));
  assert.ok(searched.length <= 3);

  const plain = parseAnalysisPayload(
    'UEFI Driver Binding Protocol Version field',
    '原始问题',
    { structured: true, plainOk: true },
  );
  assert.equal(plain.translation, 'UEFI Driver Binding Protocol Version field');
  assert.deepEqual(plain.relatedQueries, []);

  const broken = parseAnalysisPayload(
    '{"translation":',
    '原始问题',
    { structured: true, plainOk: false },
  );
  assert.equal(broken.translation, '原始问题');
});

test('relational hits prefer docs over leading commit noise', () => {
  assert.equal(RELATIONAL_SOURCE, 'tianocore-docs');
  const commits = Array.from({ length: 10 }, (_, i) => ({
    source: i % 2 ? 'edk2-prs' : 'edk2-commits',
    file: `commit_${i}`,
    title: `fix version ${i}`,
    content: 'changelog',
  }));
  const guide = doc(CONNECT, { title: 'ConnectController', content: 'Version orders drivers' });
  const picked = selectRelationalHits([...commits, guide], 4);
  assert.equal(picked[0].file, CONNECT);
  assert.ok(picked.filter((r) => r.source === 'tianocore-docs').length >= 1);
  assert.ok(picked.length <= 4);
});

test('SUMMARY siblings are 3142 for 3141, and 9.2 for 9.1, not the other chapter', () => {
  const summaries = [{ repo: REPO, text: SUMMARY }];
  const fromConnect = planDirectoryNeighbors({
    seeds: [doc(CONNECT, { title: '3.14.1 ConnectController()' })],
    pool: [],
    summaries,
  });
  assert.equal(fromConnect.length, 1);
  assert.match(fromConnect[0].file, /3142_loading_uefi_option_rom_drivers\.md$/);
  assert.equal(fromConnect.some((p) => /91_driver_binding/.test(p.file)), false);
  assert.equal(fromConnect.some((p) => /3141_configuring_debuglib/.test(p.file)), false);
  assert.equal(fromConnect.some((p) => /16_driver_supported_efi_version/.test(p.file)), false);

  const fromBinding = planDirectoryNeighbors({
    seeds: [doc(BINDING)],
    pool: [],
    summaries,
  });
  assert.equal(fromBinding.length, 1);
  assert.match(fromBinding[0].file, /92_driver_binding_protocol_template\.md$/);
  assert.equal(fromBinding.some((p) => /3141_connectcontroller/.test(p.file)), false);

  const debug = planDirectoryNeighbors({
    seeds: [doc(DEBUGLIB)],
    pool: [],
    summaries,
  });
  assert.equal(debug.length, 0);
});

test('a sibling already in the recall pool is reused, including Windows paths', () => {
  const chunk = doc(
    `${REPO}\\3_foundation\\314_uefi_driver_model_connection_process\\3142_loading_uefi_option_rom_drivers.md`,
    { title: '3.14.2 Loading UEFI option ROM drivers', content: 'option ROM is tried before Version order' },
  );
  const plans = planDirectoryNeighbors({
    seeds: [doc(CONNECT)],
    pool: [chunk, doc(BINDING)],
    summaries: [{ repo: REPO, text: 'File: SUMMARY.md\nSection: Summary\n' + SUMMARY }],
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].chunk, chunk);

  const kept = planDirectoryNeighbors({
    seeds: [doc(CONNECT), chunk],
    pool: [chunk],
    summaries: [{ repo: REPO, text: SUMMARY }],
  });
  assert.equal(kept.some((p) => /3142_/.test(p.file)), false);
});

test('without a SUMMARY, only same-directory chunks already retrieved are added', () => {
  const rom = doc(OPTION_ROM, { content: 'option rom' });
  const plans = planDirectoryNeighbors({
    seeds: [doc(CONNECT)],
    pool: [rom, doc(BINDING), doc(DISCONNECT)],
    summaries: [],
  });
  const files = plans.map((p) => p.file);
  assert.ok(files.includes(OPTION_ROM));
  assert.equal(files.includes(BINDING), false);
  assert.ok(plans.length <= 2);
});

test('flag off returns no neighbors; disk SUMMARY supplies a missing sibling', () => {
  const seed = doc(CONNECT, { title: 'ConnectController' });
  const off = maybeExpandDirectoryNeighbors({
    kept: [seed],
    pool: [],
    reposDir: os.tmpdir(),
  }, { RELATIONAL_QUERY_EXPANSION: 'false' });
  assert.deepEqual(off, []);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edk2-neighbors-'));
  const dir = path.join(root, REPO, '3_foundation', '314_uefi_driver_model_connection_process');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, REPO, 'SUMMARY.md'), SUMMARY);
  fs.writeFileSync(
    path.join(dir, '3142_loading_uefi_option_rom_drivers.md'),
    '# 3.14.2\n\nOption ROM drivers are ordered ahead of the Version field.\n',
  );
  const partial = `
 * [3.14.1 ConnectController()](3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md)
`;
  const on = maybeExpandDirectoryNeighbors({
    kept: [seed],
    pool: [{
      source: 'tianocore-docs',
      file: `${REPO}/SUMMARY.md`,
      content: partial,
    }],
    reposDir: root,
  }, {});
  assert.equal(on.length, 1);
  assert.match(on[0].file, /3142_loading_uefi_option_rom_drivers\.md$/);
  assert.match(on[0].content, /Option ROM drivers are ordered/);
  assert.equal(on[0].source, 'tianocore-docs');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a short SUMMARY chunk that links the seed beats a longer unrelated chunk', () => {
  const long = '# Summary\n' + '* [1 Introduction](1_introduction/README.md)\n'.repeat(30);
  const short = `
 * [3.14.1 ConnectController()](3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md)
 * [3.14.2 Loading UEFI option ROM drivers](3_foundation/314_uefi_driver_model_connection_process/3142_loading_uefi_option_rom_drivers.md)
`;
  const rom = doc(OPTION_ROM, { content: 'option rom from pool' });
  const disc = doc(DISCONNECT, { content: 'disconnect' });
  const plans = maybeExpandDirectoryNeighbors({
    kept: [doc(CONNECT)],
    pool: [
      { source: 'tianocore-docs', file: `${REPO}/SUMMARY.md`, content: long },
      { source: 'tianocore-docs', file: `${REPO}/SUMMARY.md`, content: short },
      disc,
      rom,
    ],
    reposDir: path.join(os.tmpdir(), 'edk2-repos-missing'),
  }, {});
  assert.equal(plans.length, 1);
  assert.equal(plans[0], rom);
});

test('middle siblings are capped and commits are not seeds', () => {
  const plans = planDirectoryNeighbors({
    seeds: [
      doc(OPTION_ROM),
      { source: 'edk2-commits', file: 'commit_1', title: 'fix', content: 'x' },
      doc(`${REPO}/SUMMARY.md`, { content: SUMMARY }),
    ],
    pool: [],
    summaries: [{ repo: REPO, text: SUMMARY }],
    max: 4,
  });
  const files = plans.map((p) => p.file).join('\n');
  assert.match(files, /3143_disconnectcontroller\.md/);
  assert.match(files, /3141_connectcontroller\.md/);
  assert.equal(files.includes('commit_1'), false);
  assert.equal(files.includes('SUMMARY.md'), false);
  assert.ok(plans.length <= 4);
});
