'use strict';

/**
 * Focused-query routing for the web orchestrator.
 *
 * Chinese questions against an English corpus often miss the reference
 * chapter (Issue #12 / PROGRESS: ~48% reference-doc recall). Each topic
 * fires a few precise English queries, and the source is chosen so the
 * right corpus actually occupies top-k:
 *
 *   tianocore-docs          coding style, PCD, Depex, modules, build, drivers
 *   tianocore-wiki          commit message / partitioning / Uncrustify / CI
 *   uefi-specs + wiki + docs
 *                           UEFI/PI spec topics (boot flow, PPI/HOB, Boot and
 *                           Runtime Services, Event/TPL, memory, variables,
 *                           SMM, HII, Secure Boot). These used to search
 *                           source=all, where edk2-commits / edk2-prs fill
 *                           the window before the spec chunk is seen.
 *
 * FOCUS_TOPIC_ROUTING=false restores the previous behavior: spec topics
 * search source=all as a single query, the topics added here are skipped,
 * the extra complex-tier cues are off, and the candidate merge uses the
 * old interleave. FOCUS_QUERY_CAP caps how many focused calls one question
 * may spawn (default 36 when routing is on).
 */

const SPEC_SOURCES = ['uefi-specs', 'tianocore-wiki', 'tianocore-docs'];

const FOCUS_TOPICS = [
  {
    id: 'spacing',
    sources: ['tianocore-docs'],
    re: /spacing|formatting|indentation|排版|空白|缩进|风格|style|vertical|horizontal|coding.?standard|编码规范/i,
    queries: [
      'C Coding Standards 5.2 Spacing Vertical Spacing blank lines Horizontal Spacing indentation File Heading section rules',
      'Formatting General Rules Vertical spacing Horizontal spacing Predicate Expressions quick reference source_files',
      '5.2.2.1 spaces binary operators unary operators multi-line function calls alignment commas semicolons open parenthesis open brace array subscripts',
    ],
    extraQueries: [
      '5.3 Include Files pragma once no Tab characters 120 columns CRLF line endings ASCII file general rules',
    ],
  },
  {
    id: 'naming',
    sources: ['tianocore-docs'],
    re: /naming|命名|identifier|标识符|hungarian|匈牙利|大小写|name space/i,
    queries: [
      'C Coding Standards naming conventions identifiers Hungarian prefixes function and data names type and macro names',
      'global and module variables recommendations naming rules 4.4 4.5 name space rules file names directory names',
    ],
  },
  {
    id: 'function-layout',
    sources: ['tianocore-docs'],
    re: /function layout|函数|注释|comment|doxygen|文件头|函数头|documenting/i,
    queries: [
      'C Programming function definition layout function headings parameter modifiers EFIAPI VOID parameter list',
      'what you must comment Doxygen file heading copyright SPDX-License-Identifier Specification Reference',
      'code file structure file header comment block what not to comment spurious variable assignment',
    ],
  },
  {
    id: 'flow-control',
    sources: ['tianocore-docs'],
    re: /flow control|goto|assert|流程控制|注释禁忌|error handling/i,
    queries: [
      'Flow Control Statements compound statement Goto Statements should not be used',
      'Error Handling and ASSERT assertion not for error handling PcdDebugPropertyMask',
      'what not to comment BUGBUG FIX_THIS markers comments',
    ],
  },
  {
    id: 'pcd',
    sources: ['tianocore-docs'],
    re: /pcds|pcd\b|patchable|featureflag|fixedatbuild|dynamicex|pcd.*(类型|写法|怎么|如何|动态|固定)/i,
    queries: [
      'PCD types PcdsFeatureFlag PcdsFixedAtBuild PcdsPatchableInModule PcdsDynamic PcdsDynamicEx module declaration',
      'DEC PCD declaration section DSC PCD section INF PCD section access macro FixedPcdGet PatchPcdGet PcdGet PcdSet DynamicEx',
    ],
  },
  {
    id: 'depex',
    sources: ['tianocore-docs'],
    re: /depex|依赖表达式|dependency expression/i,
    queries: [
      '[Depex] section dependency expression INF grammar TRUE AND OR NOT module dispatch',
      'dependency expression depex module dispatch order PPI protocol inherited from libraries',
    ],
  },
  {
    id: 'module-type',
    sources: ['tianocore-docs'],
    re: /module type|module_type|library class|library instance|库类|库实例|entry point|入口点/i,
    queries: [
      'EDK II Module Types table module type PEIM DXE_DRIVER UEFI_APPLICATION entry point library',
      'library class library instance DSC LibraryClasses mapping LIBRARY_CLASS constructor destructor produced library class',
      'what is an EDK II module adding a module directory module meta file INF',
    ],
  },
  {
    // INF/DEC/DSC/FDF and the module/package/platform relationship live in
    // Module Writer's Guide 1.1 / 2.1. A single "INF" mention is not enough:
    // expansion text names every meta file, so the matcher looks at the
    // original question only.
    id: 'metadata-files',
    added: true,
    sources: ['tianocore-docs'],
    match(question) {
      const q = String(question || '');
      const files = ['inf', 'dec', 'dsc', 'fdf'].filter((name) =>
        new RegExp('\\b' + name + '\\b', 'i').test(q));
      if (files.length >= 2) return true;
      if (/元数据/.test(q)) return true;
      if (/模块/.test(q) && /包/.test(q) && /平台/.test(q)) return true;
      if (/\bmodule\b/i.test(q) && /\bpackage\b/i.test(q) && /\bplatform\b/i.test(q)) return true;
      return false;
    },
    queries: [
      'EDK II 1.1.1 Module Package and Platform 1.1.4 Build Infrastructure INF DEC DSC FDF overview',
      '2.1.3 Package Declaration File DEC 2.1.4 Package DSC File Defines Components LibraryClasses FDF flash',
    ],
  },
  {
    // "Why not int/char" is C Coding Standards 5.6, not the function-layout
    // chapter. The question does not contain 函数, so the older topic misses it.
    id: 'efi-data-types',
    added: true,
    sources: ['tianocore-docs'],
    re: /数据类型|标准\s*C|EFIAPI|\bUINTN\b|\bINTN\b|\bCHAR16\b|\bEFI_STATUS\b|不能用\s*int|\bint\b.{0,16}\bchar\b/i,
    queries: [
      'C Coding Standards 5.6.1 Common Data Types declarations and types BOOLEAN INTN UINTN CHAR8 CHAR16 VOID EFI_GUID EFI_STATUS EFIAPI',
      'Modifiers IN OUT OPTIONAL CONST VOLATILE UNALIGNED typedef struct enum bit fields Table 6 Table 7 EFI Data Types',
    ],
  },
  {
    id: 'driver-binding',
    sources: ['tianocore-docs'],
    re: /driver binding|driverbinding|driver model|驱动绑定|驱动模型|Supported\s*\/\s*Start|Supported\(|Start\(|Stop\(|EFI_DRIVER_BINDING|总线驱动|设备驱动/i,
    queries: [
      'UEFI Driver Writers Guide Driver Binding Protocol Template Supported Start Stop EFI_DRIVER_BINDING_PROTOCOL',
      'Driver Binding Protocol implementations UEFI driver categories device drivers bus drivers required features',
      'PCI driver Start order open protocol allocate private context PciIo Attributes Enable Command register DMA RemainingDevicePath',
      'Start and Stop PCI drivers PciIo Attributes EfiPciIoAttributeOperationSet OriginalPciAttributes Example 171 172',
      'multiple Driver Binding instances sum of products Version ConnectController priority verification Shell load dh connect disconnect reconnect drivers devices devtree openinfo unload',
      'Driver Binding Protocol and Child Management BY_CHILD_CONTROLLER DevicePath RemainingDevicePath Start order',
    ],
  },
  {
    id: 'protocol-services',
    sources: ['tianocore-docs'],
    re: /locateprotocol|locatehandle|openprotocol|closeprotocol|protocol|协议|handle|句柄/i,
    queries: [
      'Handle Database and Protocol Services LocateHandleBuffer LocateProtocol OpenProtocol CloseProtocol Attributes',
      'EFI_OPEN_PROTOCOL TEST_PROTOCOL GET_PROTOCOL BY_DRIVER BY_CHILD_CONTROLLER EXCLUSIVE usage return codes EFI_ACCESS_DENIED EFI_ALREADY_STARTED',
      'InstallMultipleProtocolInterfaces UninstallMultipleProtocolInterfaces rollback handle database',
    ],
  },
  {
    id: 'build-debug',
    sources: ['tianocore-docs'],
    re: /build|编译|AutoGen|PatchCheck|报错|LNK2001|error 4000|调试|debug|DEBUG\(|debugging/i,
    queries: [
      'Building the module Add the module INF in package DSC build command BuildOptions build module image AutoGen',
      'Common build module breaks error 4000 Value of Guid is not found LNK2001 unresolved external symbol File name case mismatch',
      'Debugging a Module required steps PcdDebugPropertyMask PcdDebugPrintErrorLevel DebugLib CpuDeadLoop map file',
    ],
  },
  {
    id: 'contribution',
    sources: ['tianocore-wiki'],
    // "sign"/"patch" must not fire on SIGNAL / Patchable — those pulled the
    // wiki commit pages into spec and PCD questions and crowded the window.
    re: /commit|贡献|contribution|\bpatch\b|uncrustify|\bci\b|review|签名|signed-off|sign-off|\bsign\b|\bpr\b|拆分|partition|格式化/i,
    queries: [
      'Commit Message Format Commit Signature Format commit partitioning contribution guide',
      'commit message format Pkg-Module Brief single line summary Signed-off-by Reviewed-by signatures length',
      'EDK II Code Formatting Uncrustify developer workflow uncrustify.cfg tianocore-uncrustify stuart_update stuart_ci_build',
      'EDK II Continuous Integration PatchCheck UncrustifyCheck SpellCheck Mergify push label',
      'EDK II Development Process Contributor Process Maintainer Process',
    ],
  },
  {
    id: 'boot-flow',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    re: /启动流程|boot flow|boot sequence|启动阶段|PEI|PPI|HOB|SEC\b|DXE\b|BDS\b|TSL\b|PEIM|pre-efi/i,
    queries: [
      'PI boot flow SEC PEI DXE BDS TSL RT phases overview',
      'PEIM-to-PEIM Interfaces PPI Services PEI Services Table HOB Hand-Off Block PEI to DXE handoff',
      'PEI Services CreateHob GetHobList InstallPpi LocatePpi NotifyPpi Firmware Volume PEI Memory InstallPeiMemory',
    ],
    extraQueries: [
      'UEFI PI Specification Pre-EFI Initialization PEI Phase Volume I PEIM-to-PEIM Interfaces PPIs HOB Hand-Off Block',
    ],
  },
  {
    id: 'boot-runtime',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    re: /boot services|runtime services|exitbootservices|运行时|启动服务|system table/i,
    queries: [
      'Boot Services Runtime Services difference ExitBootServices memory map runtime drivers',
      'Runtime Services rules and restrictions SetVirtualAddressMap EVT_SIGNAL_VIRTUAL_ADDRESS_CHANGE Event Group',
    ],
    extraQueries: [
      'UEFI Specification 7.4.6 ExitBootServices 8.1 Runtime Services Rules and Restrictions Boot Services memory map MapKey',
    ],
  },
  {
    id: 'tpl-event',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    re: /\bTPL\b|raisetpl|restoretpl|event\b|事件|EVT_|timer|notify/i,
    queries: [
      'Task Priority Level RaiseTPL RestoreTPL event notification TPL restrictions table',
      'CreateEvent CreateEventEx SetTimer EVT_TIMER EVT_NOTIFY_SIGNAL EVT_NOTIFY_WAIT EVT_SIGNAL_EXIT_BOOT_SERVICES event group',
    ],
    extraQueries: [
      'EVT_SIGNAL_EXIT_BOOT_SERVICES handler DXE drivers 8.7 CreateEventEx EFI_EVENT_GROUP_EXIT_BOOT_SERVICES',
    ],
  },
  {
    id: 'memory',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    re: /allocatepages|allocatepool|memory type|内存|EfiLoaderData|EfiBootServicesData|EfiRuntimeServicesData|allocate/i,
    queries: [
      'AllocatePages AllocatePool memory allocation services memory type EfiLoaderData EfiBootServicesData EfiRuntimeServicesData GetMemoryMap FreePages FreePool',
    ],
    extraQueries: [
      'UEFI Specification 7.2 Memory Allocation Services AllocatePages AllocatePool GetMemoryMap EfiBootServicesData EfiRuntimeServicesData EfiLoaderData',
    ],
  },
  {
    id: 'variable',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    // Bare "attributes" also names OpenProtocol Attributes and would fan
    // this spec topic into a handle-database question.
    re: /variable|变量|getvariable|setvariable|non_volatile/i,
    queries: [
      'Variable Services GetVariable SetVariable QueryVariableInfo attributes NON_VOLATILE BOOTSERVICE_ACCESS RUNTIME_ACCESS APPEND_WRITE time based authenticated',
    ],
    extraQueries: [
      'UEFI Variable Services 8.2 GetVariable SetVariable gEfiVariableArchProtocolGuid communication between UEFI drivers 5.4.2',
    ],
  },
  {
    id: 'smm',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    re: /\bSMM\b|management mode|standalone mm|mm_standalone|munblockmemoryrequest|mmst/i,
    queries: [
      'Standalone MM introduction Management Mode traditional SMM DXE_SMM_DRIVER differences',
      'MM Core Interface MMST MmUnblockMemoryRequest CommBuffer shadow buffer TOCTOU',
    ],
  },
  {
    id: 'hii',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    re: /\bHII\b|\bVFR\b|human interface|form browser|setup|界面|配置界面|ifr/i,
    queries: [
      'HII Human Interface Infrastructure overview forms strings VFR IFR HiiDatabase HiiAddPackages',
      'VFR description in BNF formset form oneof numeric checkbox question varstore EFI_HII_CONFIG_ACCESS_PROTOCOL ExtractConfig RouteConfig',
    ],
  },
  {
    id: 'secure-boot',
    legacySource: 'all',
    sources: SPEC_SOURCES,
    re: /secure boot|trusted boot|measured boot|\bpk\b|kek|dbx|安全启动|trusted/i,
    queries: [
      'Secure Boot chain integrity models PK KEK db dbx authorized forbidden image database verification',
      'Trusted Boot measured boot TPM PCR event log remote attestation',
    ],
    extraQueries: [
      'Understanding UEFI Secure Boot Chain PK KEK db dbx dbt dbr authorized forbidden image database verified boot measured boot',
    ],
  },
];

const COMPLEX_CUES =
  /(有哪些|哪些|列举|列出|分别|各自|规则|规定|要求|约束|流程|步骤|规范|标准|禁忌|注意事项|边界|怎么|如何|怎样|为什么|原理|区别|不同|几个|哪些方面)/i;

// Cues that were still falling through to simple/standard on the custom
// question set ("有几种类型", "按什么顺序", "什么时候必须"). Gated by
// FOCUS_TOPIC_ROUTING so the rollback really restores the old tier.
const COMPLEX_CUES_EXTRA = /(有几种|哪几种|什么时候|何时|顺序|职责)/;

function focusRoutingEnabled(env = process.env) {
  const v = env && Object.prototype.hasOwnProperty.call(env, 'FOCUS_TOPIC_ROUTING')
    ? env.FOCUS_TOPIC_ROUTING
    : undefined;
  if (v == null || v === '') return true;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

function focusQueryCap(env, enabled) {
  const raw = env && env.FOCUS_QUERY_CAP;
  const n = parseInt(raw == null ? '' : String(raw), 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return enabled ? 36 : 40;
}

function routingEnabled(opts) {
  if (opts && opts.enabled !== undefined) return !!opts.enabled;
  return focusRoutingEnabled(opts && opts.env);
}

function topicSources(topic, enabled) {
  if (!enabled) {
    if (topic.added) return [];
    if (topic.legacySource) return [topic.legacySource];
  }
  if (Array.isArray(topic.sources) && topic.sources.length) return topic.sources.slice();
  if (topic.source) return [topic.source];
  return ['tianocore-docs'];
}

function topicQueries(topic, enabled) {
  const base = topic.queries || [];
  if (enabled && Array.isArray(topic.extraQueries) && topic.extraQueries.length) {
    return base.concat(topic.extraQueries);
  }
  return base.slice();
}

/**
 * Focused /search plans for one question.
 * `question` is the raw user text (metadata-file counting). `opts.blob`
 * may also include the English translation and keyword expansion, which is
 * what the topic regexes are applied to.
 */
function selectFocusQueries(question, opts = {}) {
  const enabled = routingEnabled(opts);
  const cap = opts.maxPlans != null ? opts.maxPlans : focusQueryCap(opts.env, enabled);
  const blob = opts.blob != null ? String(opts.blob) : String(question || '');
  const raw = String(question || '');
  const plans = [];
  const seen = new Set();
  for (const topic of FOCUS_TOPICS) {
    const sources = topicSources(topic, enabled);
    if (!sources.length) continue;
    let hit = false;
    if (typeof topic.match === 'function') hit = !!topic.match(raw, blob);
    else if (topic.re) hit = topic.re.test(blob);
    if (!hit) continue;
    const queries = topicQueries(topic, enabled);
    // Several sources: round-robin so uefi-specs, wiki and docs each get a
    // query before a later query repeats the first source. Cap per topic
    // so one question cannot fan out without bound. Hitting the per-topic
    // cap must not drop later topics; only the global cap stops the scan.
    const perTopic = sources.length > 1 ? Math.min(queries.length * sources.length, 12) : queries.length;
    let n = 0;
    let topicFull = false;
    for (const q of queries) {
      for (const source of sources) {
        const key = source + '\n' + q;
        if (seen.has(key)) continue;
        seen.add(key);
        plans.push({ q, source, topic: topic.id });
        n += 1;
        if (plans.length >= cap) return plans;
        if (n >= perTopic) { topicFull = true; break; }
      }
      if (topicFull) break;
    }
  }
  return plans;
}

function classifyQuestion(question) {
  const q = String(question || '').toLowerCase();

  const patterns = {
    howto: /^(如何|怎么|怎样|how to|how do i)/i,
    what: /^(是什么|什么是|what is|what are)/i,
    format: /^(格式|格式是什么|format|format of)/i,
    error: /^(错误|报错|失败|error|fail|cannot|问题)/i,
    example: /^(示例|例子|example|sample|demo)/i,
    list: /^(列出|列举|有哪些|list|what are the)/i,
    compare: /^(区别|差异|比较|compare|difference)/i,
    best: /^(最佳|推荐|建议|best|recommend)/i,
  };

  for (const [type, regex] of Object.entries(patterns)) {
    if (regex.test(q)) return type;
  }

  if (/commit|提交|签名|sign/.test(q)) return 'format';
  if (/驱动|driver|protocol|协议/.test(q)) return 'howto';
  if (/pcd|inf|dsc|dec/.test(q)) return 'format';
  if (/启动|boot|pei|dxe/.test(q)) return 'what';

  return 'general';
}

// Query routing. complex → dedup=false, wider top-k, larger context.
// Enumerative / rules / process / how-to questions need several sections of
// one document; simple/standard collapse to a single chunk and the answer
// then says the detail is missing.
function routeQuery(question, opts = {}) {
  const q = String(question || '').trim();
  if (!q) return 'standard';
  const enabled = routingEnabled(opts);

  if (/(比较|区别|差异|对比|compare|difference|vs\.?| versus |各自|分别.*和|和.*分别|为什么|原理|工作机制|底层|根因|root\s*cause|如何.*实现)/i.test(q)) {
    return 'complex';
  }
  if ((q.match(/[?？]/g) || []).length >= 2) return 'complex';
  if (COMPLEX_CUES.test(q)) return 'complex';
  if (enabled && COMPLEX_CUES_EXTRA.test(q)) return 'complex';

  const cls = classifyQuestion(q);
  const short = q.length <= 22;

  if (short && (cls === 'what' || cls === 'format' || cls === 'list' || cls === 'example')) {
    return 'simple';
  }
  if (short && cls !== 'howto' && cls !== 'error' && cls !== 'general') {
    return 'simple';
  }
  const ids = (q.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);
  if (short && ids.length <= 2 && cls !== 'howto' && cls !== 'error') {
    return 'simple';
  }
  return 'standard';
}

// Mirrors the web tier budgets. complex keeps multiple chunks per document.
function retrievalParams(tier) {
  if (tier === 'simple') return { topK: 15, dedup: true };
  if (tier === 'complex') return { topK: 30, dedup: false };
  return { topK: 22, dedup: true };
}

function chunkKey(r) {
  if (!r) return '';
  if (r.url) return r.url;
  const file = r.file || '';
  if (file) return r.section ? `${file}#${r.section}` : file;
  return r.title || r.section || (r._pid != null ? String(r._pid) : '') || '';
}

function isNoiseChunk(r) {
  const src = String((r && r.source) || '').toLowerCase();
  if (src === 'edk2-commits' || src === 'edk2-prs') return true;
  const disp = String((r && r.source_display) || '').toLowerCase();
  if (disp.includes('edk2-commits') || disp.includes('edk2-prs')) return true;
  const file = String((r && r.file) || '').toLowerCase();
  if (/(^|[\\/])edk2-commits([\\/]|$)/.test(file)) return true;
  if (/(^|[\\/])edk2-prs([\\/]|$)/.test(file)) return true;
  if (/(^|[\\/])commit_\d/.test(file) || /(^|[\\/])pr_\d/.test(file)) return true;
  return false;
}

// A question that is itself about one git object should still see commit/PR
// records. "commit message 怎么写" does not: there is no object id.
function wantsCommitCorpus(question) {
  const q = String(question || '');
  if (/\b[0-9a-f]{7,40}\b/i.test(q) && /commit|提交|\bpr\b|pull request/i.test(q)) return true;
  if (/这次提交|该提交|这个\s*commit|commit\s*[0-9a-f]{6,}/i.test(q)) return true;
  return false;
}

/**
 * Distinctive Latin anchors: underscored identifiers, CamelCase API names,
 * long ALLCAPS tokens, dotted section numbers (5.2.2, 18.3.1, 7.4.6), and
 * function names written with parentheses. Short tokens (INF, PCD, SEC) are
 * omitted — they occur in every source and do not separate signal from noise.
 */
function preciseAnchors(question) {
  const q = String(question || '');
  const found = [];
  const add = (s) => {
    const t = String(s || '').trim().toLowerCase();
    if (t.length >= 4) found.push(t);
  };
  for (const m of q.matchAll(/\b\d+\.\d+\.\d+(?:\.\d+)*\b/g)) add(m[0]);
  for (const m of q.matchAll(/(?:§|章节|section|第)\s*(\d{1,2}\.\d{1,2})\b/gi)) add(m[1]);
  for (const m of q.matchAll(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]{2,}\b/g)) add(m[0]);
  for (const m of q.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g)) add(m[0]);
  for (const m of q.matchAll(/\b[A-Z][A-Z0-9]{7,}\b/g)) add(m[0]);
  for (const m of q.matchAll(/\b([A-Za-z][A-Za-z0-9]{3,})\s*\(/g)) add(m[1]);
  return [...new Set(found)];
}

function chunkHaystack(r) {
  return [r && r.title, r && r.section, r && r.file, r && r.url, r && r.content, r && r.snippet]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function chunkMatchesAnchors(r, anchors) {
  if (!anchors || !anchors.length || !r) return false;
  const hay = chunkHaystack(r);
  return anchors.some((a) => hay.includes(a));
}

function protectedChunkKeys(results, focusResults, question, extraAnchors) {
  const keys = new Set();
  for (const r of focusResults || []) {
    const k = chunkKey(r);
    if (k) keys.add(k);
  }
  const anchors = preciseAnchors(question);
  for (const a of extraAnchors || []) {
    const s = String(a || '').trim().toLowerCase();
    if (s.length >= 4 && !anchors.includes(s)) anchors.push(s);
  }
  if (!anchors.length) return keys;
  for (const r of results || []) {
    if (!r || isNoiseChunk(r)) continue;
    const id = String(r.source || '').toLowerCase();
    if (id !== 'uefi-specs' && id !== 'tianocore-wiki' && id !== 'tianocore-docs' && id !== 'tianocore-wiki-git') {
      continue;
    }
    if (chunkMatchesAnchors(r, anchors)) {
      const k = chunkKey(r);
      if (k) keys.add(k);
    }
  }
  return keys;
}

function legacyMerge(lanes) {
  const broad = lanes.broad || [];
  const docs = [...(lanes.docs || [])];
  const seenDocs = new Set(docs.map(chunkKey));
  for (const r of lanes.focus || []) {
    const k = chunkKey(r);
    if (!seenDocs.has(k)) { seenDocs.add(k); docs.push(r); }
  }
  const seenBroad = new Set(broad.map(chunkKey));
  const docsOnly = docs.filter((r) => !seenBroad.has(chunkKey(r)));
  const subHits = lanes.sub || [];
  const relHits = lanes.relational || [];
  const pool = [];
  const poolSeen = new Set();
  const add = (r) => {
    const k = chunkKey(r);
    if (!poolSeen.has(k)) { poolSeen.add(k); pool.push(r); }
  };
  for (const r of broad.slice(0, 3)) add(r);
  for (const r of relHits.slice(0, 25)) add(r);
  for (const r of docsOnly.slice(0, 8)) add(r);
  for (const r of subHits.slice(0, 10)) add(r);
  for (const r of broad.slice(3, 7)) add(r);
  return pool.slice(0, 50);
}

/**
 * Merge the parallel retrieval lanes.
 * When routing is on AND the question has a focused topic or a precise
 * anchor, spec/docs/wiki chunks are reserved ahead of commit/PR noise and
 * ahead of the relational expansion. Otherwise the historical interleave is
 * kept (relational expansion still has to surface ConnectController-style
 * neighbors that no focus rule names).
 */
function extraAnchorList(lanes, opts) {
  return []
    .concat((lanes && lanes.anchors) || [], (opts && opts.anchors) || [])
    .map((a) => String(a || '').trim().toLowerCase())
    .filter((a) => a.length >= 4);
}

function downrankList(lanes, opts) {
  return []
    .concat((lanes && lanes.downrank) || [], (opts && opts.downrank) || [])
    .map((a) => String(a || '').trim().toLowerCase())
    .filter((a) => a.length >= 8);
}

function mergeRetrievalPool(lanes, opts = {}) {
  const enabled = routingEnabled(opts);
  const question = (lanes && lanes.question) || '';
  if (!enabled || wantsCommitCorpus(question)) return legacyMerge(lanes || {});

  const broad = (lanes && lanes.broad) || [];
  const docs = (lanes && lanes.docs) || [];
  const focus = (lanes && lanes.focus) || [];
  const sub = (lanes && lanes.sub) || [];
  const relational = (lanes && lanes.relational) || [];
  const extra = extraAnchorList(lanes, opts);
  const downrank = downrankList(lanes, opts);
  const anchors = preciseAnchors(question);
  for (const a of extra) {
    if (!anchors.includes(a)) anchors.push(a);
  }
  if (!focus.length && !anchors.length) return legacyMerge(lanes || {});

  const pool = [];
  const seen = new Set();
  const add = (r) => {
    if (!r) return false;
    const k = chunkKey(r);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    pool.push(r);
    return true;
  };
  const take = (arr, n, pred) => {
    let count = 0;
    for (const r of arr) {
      if (count >= n) break;
      if (pred && !pred(r)) continue;
      if (add(r)) count += 1;
    }
  };
  // distinguishes_from.source_paths stay in the pool but after the hit's
  // source_paths anchors, the focus lane, and the docs lane.
  const fileHeld = (r) => {
    if (!downrank.length) return false;
    if (extra.length && chunkMatchesAnchors(r, extra)) return false;
    const f = String((r && r.file) || '').replace(/\\/g, '/').toLowerCase();
    return !!f && downrank.some((d) => f.includes(d));
  };
  const nonNoise = (r) => !isNoiseChunk(r) && !fileHeld(r);
  const anchored = (r) => anchors.length > 0 && chunkMatchesAnchors(r, anchors) && nonNoise(r);

  take([...focus, ...docs, ...broad, ...sub, ...relational].filter(anchored), 12);
  take(focus.filter(nonNoise), 16);
  take(docs.filter(nonNoise), 8);
  take(relational.filter(nonNoise), 12);
  take(sub.filter(nonNoise), 8);
  take(broad.filter(nonNoise), 6);
  if (anchors.length) {
    take([...focus, ...docs, ...broad, ...relational, ...sub].filter(
      (r) => isNoiseChunk(r) && chunkMatchesAnchors(r, anchors) && !fileHeld(r)), 3);
  }
  if (pool.length < 8) {
    take([...broad, ...relational].filter((r) => isNoiseChunk(r) && !fileHeld(r)), 2);
  }
  take([...focus, ...docs, ...broad, ...sub, ...relational].filter(
    (r) => fileHeld(r) && !isNoiseChunk(r)), 4);
  const cap = opts.cap || 50;
  return pool.slice(0, cap);
}

module.exports = {
  FOCUS_TOPICS,
  SPEC_SOURCES,
  focusRoutingEnabled,
  selectFocusQueries,
  classifyQuestion,
  routeQuery,
  retrievalParams,
  chunkKey,
  isNoiseChunk,
  wantsCommitCorpus,
  preciseAnchors,
  chunkMatchesAnchors,
  protectedChunkKeys,
  mergeRetrievalPool,
};
