# Compiled Wiki Schema

Compiled pages are a **retrieval-orchestration bridge**, not a knowledge source.
They must not be written into the existing Chroma or FTS indexes, and they are
not evidence. Citations may only count original `tianocore-docs` / `uefi-specs`
chunks resolved from `source_paths`.

The matcher (`web/compiled-wiki.js`, owned by SWE) does deterministic matching
after the similar cache and before topic routing and relational expansion.
`expansion_rules.json` continues to provide cheap lexical CN/EN expansion and
is not replaced by these pages.

## File layout

```
edk2-kb/compiled-wiki/
  SCHEMA.md          # this contract
  VERIFICATION.md    # path verification log for the first seed batch
  pages/*.md         # one sense per file
```

## Page format

Each page is Markdown with YAML frontmatter. The machine-usable contract is
the frontmatter. The body, if present, is a short human/LLM 导读 (at most one
page may be attached at generation time). Body text must not be indexed.

Aligned frontmatter fields: `canonical`, `aliases`, `sense`,
`distinguishes_from`, `source_paths`. `id` and `topic` are stable helpers
for cache keys and grouping; they are not substitutes for `canonical`.

```yaml
---
id: kebab-case-unique-id          # required, stable; cache identity
title: short Chinese or official title
topic: driver-binding             # required: one of the topic tags below
canonical: EFI_DRIVER_BINDING_PROTOCOL.Version   # required: official name
aliases:                          # required, non-empty
  - driver binding version
sense: >-                         # required: the disambiguated meaning
  Driver Binding Protocol 的 Version 字段，决定 ConnectController 连接优先级
distinguishes_from:               # optional, but required when there is a known confounder
  - id: optional
stable-id
    canonical: EFI_DRIVER_SUPPORTED_EFI_VERSION_PROTOCOL
    aliases:
      - Driver Supported EFI Version
    source_paths:                 # KB `file` values to downweight after a hit
      - source: tianocore-docs
        repo: edk2-UefiDriverWritersGuide
        file: edk2-UefiDriverWritersGuide/16_driver_supported_efi_version_protocol/README.md
source_paths:                     # required, non-empty; original docs only
  - source: tianocore-docs        # tianocore-docs | uefi-specs
    repo: edk2-UefiDriverWritersGuide
    file: edk2-UefiDriverWritersGuide/3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.md
    url: https://tianocore-docs.github.io/edk2-UefiDriverWritersGuide/draft/3_foundation/314_uefi_driver_model_connection_process/3141_connectcontroller.html
---
```

### Field rules

| Field | Matcher use |
| --- | --- |
| `canonical` | Official name used when rewriting the query after a hit. |
| `aliases` | Deterministic phrase match against the user query and its translation. Case-insensitive; collapse whitespace; keep punctuation
stripping conservative (do not strip digits or dots in `9.1` / `3.14.1`). Prefer the longest alias hit. |
| `sense` | The disambiguated meaning. Topic routing and relational expansion run from this sense, not the raw surface form, after a high-confidence hit. |
| `distinguishes_from.source_paths` | Downweight these original paths in the candidate pool (they are still originals, just the wrong sense). |
| `source_paths` | Seed the existing exact-anchor merge, ahead of focus-topic hits and the docs path. `file` must equal the KB metadata `file` field: for `tianocore-docs` this is `{repo}/{path-inside-repo}` (see `init_kb.py`, `rel_path` relative to `tianocore-docs/repos/`). |

### Topic tags (first batch)

`driver-binding`, `ppi-hob`, `boot-runtime`, `event-tpl`, `secure-boot`

## Match / fallback

A hit requires at least one alias match and at least one `source_paths` entry.
If no alias matches, or two or more pages match with the same longest-alias
length, treat it as **no match** and immediately fall back to the existing
pipeline. Never invent a path or force a low-confidence sense.

Generic single tokens (`version`, `boot`, `event`) must not appear alone as
aliases. Official acronyms (`PPI`, `HOB`, `TPL`) are allowed. Aliases should
be phrases or official names that actually disambiguate.

Do not use compiled-page body text as a search query against the existing index.

## Cache

Similar-cache replay after a compiled-wiki hit is allowed only when the cached
entry carries the same `id` (sense) and the same `source_paths` file set.
A miss, a stale entry, or a path/id mismatch is a cache miss.

## Feature flag

`COMPILED_WIKI=false` (and `0` / `off` / `no`) disables matching entirely.
The first phase does not rebuild the ~16G index and does not write Q&A back
into these pages.
