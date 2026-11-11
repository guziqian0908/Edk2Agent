'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  selectFocusQueries,
  routeQuery,
  retrievalParams,
  mergeRetrievalPool,
  isNoiseChunk,
  preciseAnchors,
  protectedChunkKeys,
  focusRoutingEnabled,
} = require('./retrieval-routing');

const ON = { enabled: true };
const OFF = { enabled: false };
const SPEC = ['uefi-specs', 'tianocore-wiki', 'tianocore-docs'];

function plans(question, opts = ON) {
  return selectFocusQueries(question, { ...opts, blob: opts.blob != null ? opts.blob : question });
}

function sourcesOf(question, topic, opts) {
  return [...new Set(plans(question, opts).filter((p) => p.topic === topic).map((p) => p.source))];
}

function loadCustomQuestions() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'question.txt'), 'utf8');
  const qs = [];
  for (const part of text.split(/\n(?=Q: )/)) {
    const m = part.match(/^Q:\s*([\s\S]*?)\nA:/);
    if (m) qs.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return qs;
}

test('custom question set routes to complex so dedup stays off', () => {
  const qs = loadCustomQuestions();
  assert.ok(qs.length >= 30, `parsed ${qs.length} questions`);
  const missed = qs.filter((q) => routeQuery(q, ON) !== 'complex');
  assert.deepEqual(missed, []);
  for (const q of qs) {
    const tier = routeQuery(q, ON);
    const params = retrievalParams(tier);
    assert.equal(params.dedup, false);
    assert.equal(params.topK, 30);
  }
});

test('short factual lookups stay simple; order/有几种 become complex only when routing is on', () => {
  assert.equal(routeQuery('PCD 是什么', ON), 'simple');
  assert.equal(routeQuery('PCD 是什么', OFF), 'simple');
  assert.equal(routeQuery('什么是 Depex', ON), 'simple');

  const order = 'Start() 里应该按什么顺序做事？';
  assert.equal(routeQuery(order, ON), 'complex');
  assert.equal(routeQuery(order, OFF), 'simple');

  assert.equal(routeQuery('PCD 有几种类型', ON), 'complex');
  assert.equal(routeQuery('PCD 有几种类型', OFF), 'simple');
  assert.equal(routeQuery('什么时候必须用 FixedPcd', ON), 'complex');
  assert.equal(routeQuery('什么时候必须用 FixedPcd', OFF), 'simple');

  // Cues that were already on main stay complex after rollback.
  assert.equal(routeQuery('排版和空白有哪些规定？', OFF), 'complex');
  assert.equal(routeQuery('为什么不能用 int、char', OFF), 'complex');
});

test('spec topics fan out to uefi-specs, wiki and docs, not commits or source=all', () => {
  const cases = [
    ['UEFI/PI 固件从上电到把控制权交给 OS，启动流程分哪几个阶段？', 'boot-flow'],
    ['PEI 阶段还没有 DXE 的 Boot Services，PEIM 之间怎么互相调用？PPI 和 HOB 分别是什么？', 'boot-flow'],
    ['Boot Services 和 Runtime Services 有什么区别？ExitBootServices() 被调用后呢？', 'boot-runtime'],
    ['TPL(Task Priority Level) 是什么？RaiseTPL/RestoreTPL 怎么用？', 'tpl-event'],
    ['UEFI 的事件(Event)机制怎么理解？EVT_TIMER、EVT_NOTIFY_SIGNAL、EVT_SIGNAL_EXIT_BOOT_SERVICES 各是什么意思？', 'tpl-event'],
    ['分配内存用 AllocatePages 还是 AllocatePool？EfiBootServicesData 怎么选？', 'memory'],
    ['UEFI 变量(Variable)服务怎么用？GetVariable/SetVariable 的 Attribute 是什么意思？', 'variable'],
    ['SMM 和 MM 是什么？传统 SMM 驱动和 Standalone MM 有什么区别？', 'smm'],
    ['想给固件做一个图形化设置界面，HII 是什么？VFR 文件扮演什么角色？', 'hii'],
    ['UEFI Secure Boot 的原理是什么？和 Trusted Boot 有什么区别？', 'secure-boot'],
  ];
  for (const [q, topic] of cases) {
    const src = sourcesOf(q, topic, ON).sort();
    assert.deepEqual(src, [...SPEC].sort(), `${topic} sources for: ${q.slice(0, 24)}`);
    const all = plans(q, ON);
    assert.ok(all.every((p) => p.source !== 'all' && p.source !== 'edk2-commits' && p.source !== 'edk2-prs'));
  }
});

test('style and build topics stay on tianocore-docs; commit and Uncrustify stay on wiki', () => {
  const docs = [
    ['排版和空白有哪些规定？', 'spacing'],
    ['EDK II 的命名规范有哪些硬性要求？', 'naming'],
    ['函数该怎么排版？文件头和函数头注释有什么格式要求？', 'function-layout'],
    ['流程控制语句、goto 和 ASSERT 有什么规定？', 'flow-control'],
    ['PCD 有几种类型？在 DEC / DSC / INF / C 代码里分别怎么写？', 'pcd'],
    ['[Depex] 是干什么用的？', 'depex'],
    ['MODULE_TYPE 都有哪些？入口函数又是怎么告诉构建系统的？', 'module-type'],
    ['写一个遵循 UEFI Driver Model 的驱动，Supported/Start/Stop 分别该做什么？', 'driver-binding'],
    ['拿一个 Protocol 到底该用 LocateProtocol 还是 OpenProtocol？', 'protocol-services'],
    ['怎么只编译我自己写的那一个模块？AutoGen 文件在哪？', 'build-debug'],
    ['新手最常撞上的那几个编译/链接报错，分别是什么原因？', 'build-debug'],
  ];
  for (const [q, topic] of docs) {
    assert.deepEqual(sourcesOf(q, topic, ON), ['tianocore-docs'], topic);
  }

  const wiki = [
    ['我想给 edk2 上游提一个补丁，完整的贡献流程是什么样的？', 'contribution'],
    ['commit message 到底该怎么写？签名行有什么讲究？', 'contribution'],
    ['一个改动该拆成几个 commit？拆分标准是什么？', 'contribution'],
    ['Uncrustify 是什么？怎么在本地把代码格式化成 CI 认可的样子？', 'contribution'],
    ['PR 提上去后 CI 会跑哪些检查？', 'contribution'],
  ];
  for (const [q, topic] of wiki) {
    assert.deepEqual(sourcesOf(q, topic, ON), ['tianocore-wiki'], q.slice(0, 20));
    assert.ok(plans(q, ON).filter((p) => p.topic === 'contribution').every((p) => p.source === 'tianocore-wiki'));
  }
});

test('metadata files and EFI data types are new docs topics and disappear on rollback', () => {
  const meta = 'EDK II 里的 INF / DEC / DSC / FDF 四个元数据文件各自负责什么？模块、包、平台又是什么关系？';
  assert.ok(sourcesOf(meta, 'metadata-files', ON).includes('tianocore-docs'));
  assert.ok(plans(meta, ON).some((p) => p.q.includes('1.1.1')));
  assert.equal(plans(meta, OFF).some((p) => p.topic === 'metadata-files'), false);

  // Expansion names every meta file; a question that only says INF must not.
  const onlyInf = plans('INF 文件怎么写', {
    enabled: true,
    blob: 'INF 文件怎么写 INF DSC DEC FDF file format module package platform',
  });
  assert.equal(onlyInf.some((p) => p.topic === 'metadata-files'), false);

  const types = '为什么不能用 int、char 这些标准 C 类型？该用什么？';
  assert.deepEqual(sourcesOf(types, 'efi-data-types', ON), ['tianocore-docs']);
  assert.ok(plans(types, ON).some((p) => p.q.includes('5.6.1')));
  assert.equal(plans(types, OFF).some((p) => p.topic === 'efi-data-types'), false);
});

test('SIGNAL and Patchable do not pull the wiki commit topic', () => {
  const event = 'UEFI 的事件机制怎么理解？EVT_SIGNAL_EXIT_BOOT_SERVICES 是什么意思？';
  assert.equal(plans(event, ON).some((p) => p.topic === 'contribution'), false);
  assert.ok(plans(event, ON).some((p) => p.topic === 'tpl-event' && p.source === 'uefi-specs'));

  const pcd = 'PcdPatchableInModule 怎么写？';
  assert.equal(plans(pcd, ON).some((p) => p.topic === 'contribution'), false);
  assert.ok(plans(pcd, ON).some((p) => p.topic === 'pcd'));

  const proto = '拿一个 Protocol 到底该用 LocateProtocol 还是 OpenProtocol？OpenProtocol 的 Attributes 怎么选？';
  assert.equal(plans(proto, ON).some((p) => p.topic === 'variable'), false);
  assert.deepEqual(sourcesOf(proto, 'protocol-services', ON), ['tianocore-docs']);
});

test('rollback searches spec topics as source=all and drops the extra queries', () => {
  const q = '启动流程分哪几个阶段？PEI PPI HOB 是什么？';
  const off = plans(q, OFF).filter((p) => p.topic === 'boot-flow');
  assert.ok(off.length > 0);
  assert.ok(off.every((p) => p.source === 'all'));
  assert.equal(off.some((p) => p.q.includes('Volume I')), false);

  const on = plans(q, ON).filter((p) => p.topic === 'boot-flow');
  assert.ok(on.some((p) => p.source === 'uefi-specs'));
  assert.ok(on.some((p) => p.q.includes('Volume I')));

  const spacing = '排版和空白有哪些规定？';
  assert.equal(plans(spacing, OFF).some((p) => p.q.includes('5.3 Include Files')), false);
  assert.equal(plans(spacing, ON).some((p) => p.q.includes('5.3 Include Files')), true);
});

test('FOCUS_TOPIC_ROUTING env defaults on and accepts the false spellings', () => {
  assert.equal(focusRoutingEnabled({}), true);
  assert.equal(focusRoutingEnabled({ FOCUS_TOPIC_ROUTING: 'false' }), false);
  assert.equal(focusRoutingEnabled({ FOCUS_TOPIC_ROUTING: '0' }), false);
  assert.equal(focusRoutingEnabled({ FOCUS_TOPIC_ROUTING: 'off' }), false);
  assert.equal(focusRoutingEnabled({ FOCUS_TOPIC_ROUTING: 'true' }), true);
});

test('precise anchors keep the spec chunk ahead of commit noise', () => {
  const anchors = preciseAnchors('ExitBootServices() 之后 EFI_DRIVER_BINDING_PROTOCOL 还在吗？5.2.2 呢？');
  assert.ok(anchors.includes('exitbootservices'));
  assert.ok(anchors.includes('efi_driver_binding_protocol'));
  assert.ok(anchors.includes('5.2.2'));
  // Short tokens are not anchors: they show up in every source.
  assert.equal(preciseAnchors('PCD 是什么 INF').includes('pcd'), false);
  assert.equal(preciseAnchors('PCD 是什么 INF').includes('inf'), false);

  const spec = {
    source: 'uefi-specs',
    file: 'UEFI_Spec_Final_2.11.pdf',
    section: '7.4.6 ExitBootServices()',
    title: 'ExitBootServices',
    content: 'The loader calls ExitBootServices with the MapKey.',
  };
  const guide = {
    source: 'tianocore-docs',
    file: 'edk2-UefiDriverWritersGuide/9_driver_binding_protocol/92_driver_binding_protocol_template.md',
    section: '9.2 Driver Binding Protocol Template',
    title: 'EFI_DRIVER_BINDING_PROTOCOL',
    content: 'Version field of EFI_DRIVER_BINDING_PROTOCOL',
  };
  const spacing = {
    source: 'tianocore-docs',
    file: 'edk2-CCodingStandardsSpecification/5_source_files/52_spacing.md',
    section: '5.2.2.1 Horizontal spacing',
    title: 'Spacing',
    content: 'binary operators',
  };
  const commits = Array.from({ length: 25 }, (_, i) => ({
    source: i % 2 ? 'edk2-prs' : 'edk2-commits',
    file: `commit_${i}`,
    title: `MdeModulePkg: fix driver ${i}`,
    content: 'unrelated changelog',
  }));

  const pool = mergeRetrievalPool({
    broad: commits.slice(0, 10),
    relational: commits,
    focus: [spec, guide, spacing],
    docs: [],
    sub: [],
    question: 'ExitBootServices() 被调用后，EFI_DRIVER_BINDING_PROTOCOL 呢？5.2.2 的空格呢？',
  }, ON);

  assert.equal(pool[0].source, 'uefi-specs');
  assert.ok(pool.indexOf(guide) >= 0 && pool.indexOf(guide) < 8);
  assert.ok(pool.indexOf(spacing) >= 0);
  assert.ok(pool.filter(isNoiseChunk).length <= 3);
  assert.ok(pool.indexOf(spec) < pool.findIndex(isNoiseChunk) || pool.findIndex(isNoiseChunk) === -1);

  const keys = protectedChunkKeys(pool, [spacing], '5.2.2 横向空格怎么规定？');
  assert.ok(keys.has('edk2-CCodingStandardsSpecification/5_source_files/52_spacing.md#5.2.2.1 Horizontal spacing'));
  const commitNamed = {
    source: 'edk2-commits',
    file: 'commit_9',
    title: 'fix ExitBootServices',
    content: 'ExitBootServices',
  };
  const wiki = {
    source: 'tianocore-wiki',
    source_display: 'TianoCore Wiki (官网)',
    file: 'development/design-architecture/pi_boot_flow.md',
    title: 'RT Phase',
    content: 'ExitBootServices ends boot services',
  };
  const protect = protectedChunkKeys([wiki, commitNamed], [], 'ExitBootServices() 之后发生什么？');
  assert.equal(protect.has('development/design-architecture/pi_boot_flow.md'), true);
  assert.equal([...protect].some((k) => k.includes('commit_9')), false);
});

test('merge keeps the old interleave when routing is off, or the question names one commit', () => {
  const spec = { source: 'uefi-specs', file: 'UEFI_Spec.pdf', section: '7.4.6', title: 'ExitBootServices', content: 'ExitBootServices' };
  const commits = Array.from({ length: 8 }, (_, i) => ({
    source: 'edk2-commits', file: `commit_${i}`, title: `note ${i}`, content: 'x',
  }));
  const off = mergeRetrievalPool({
    broad: commits,
    relational: commits,
    focus: [spec],
    docs: [],
    sub: [],
    question: 'ExitBootServices() 被调用后呢？',
  }, OFF);
  assert.equal(off[0].source, 'edk2-commits');
  assert.ok(off.some((r) => r.source === 'uefi-specs'));

  const named = mergeRetrievalPool({
    broad: [commits[0]],
    relational: [],
    focus: [spec],
    docs: [],
    sub: [],
    question: 'commit abcdef1 改了什么',
  }, ON);
  assert.equal(named[0].file, 'commit_0');

  // No focus hit and no precise anchor: relational neighbors stay in front.
  const rel = { source: 'tianocore-docs', file: '3141_connectcontroller.md', title: 'ConnectController', content: 'priority' };
  const plain = mergeRetrievalPool({
    broad: [{ source: 'tianocore-docs', file: 'a.md', title: 'A', content: 'a' }],
    relational: [rel],
    focus: [],
    docs: [],
    sub: [],
    question: '驱动连接的先后',
  }, ON);
  assert.equal(plain[0].file, 'a.md');
  assert.ok(plain.some((r) => r.file === '3141_connectcontroller.md'));
});
