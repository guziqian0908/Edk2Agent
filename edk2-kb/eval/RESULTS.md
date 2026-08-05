# EDK2 KB Retrieval Evaluation

Date: 2026-08-04  Queries: 330  top_k: 10

## All queries

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 72.7% | 0.711 |
| bm25 | 27.6% | 0.247 |
| hybrid | 75.2% | 0.692 |
| hybrid+rerank | 77.0% | 0.713 |

## Manual labeled questions

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 63.1% | 0.598 |
| bm25 | 26.2% | 0.237 |
| hybrid | 64.6% | 0.537 |
| hybrid+rerank | 69.2% | 0.609 |

## Auto title questions

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 79.0% | 0.785 |
| bm25 | 28.5% | 0.254 |
| hybrid | 82.0% | 0.792 |
| hybrid+rerank | 82.0% | 0.781 |

## Reranker comparison

Manual set (130 labeled), hit@5 / MRR@10 for hybrid and hybrid+rerank
(measured with the bge-m3 embedder):

| reranker | hybrid hit@5 | hybrid MRR | +rerank hit@5 | +rerank MRR |
|---|---|---|---|---|
| (no rerank) | 64.6% | 0.537 | -- | -- |
| ms-marco-MiniLM-L-6-v2 | 64.6% | 0.537 | 66.9% | 0.614 |
| **bge-reranker-v2-m3** | 64.6% | 0.537 | 69.2% | 0.609 |

Chinese subset (8 queries, top-10 pool): rerank hit@5 62.5% (bge-v2-m3) vs
50.0% (ms-marco). English-only subset: 69.7% (bge) vs 68.0% (ms-marco).

bge-v2-m3 is the default because its sigmoid scores map faithfully to
confidence on non-English queries (a correct Chinese doc scores `high` under
bge vs `low` under ms-marco), which is what the LLM relies on to decide how
firmly to assert.

## Embedder comparison (P1 fix)

Vector index rebuilt with the multilingual **bge-m3** embedder (1024-dim,
was all-MiniLM-L6-v2 384-dim). Manual 130, hybrid+rerank hit@5:

| embedder | overall | Chinese | English |
|---|---|---|---|
| all-MiniLM-L6-v2 (384-dim) | 56.9% | 12.5% (1/8) | 59.8% |
| **bge-m3 (1024-dim)** | **69.2%** | **62.5% (5/8)** | **69.7%** |

The 384-dim index no longer matches the 1024-dim embedder; `search_engine.py`
detects the mismatch at startup and degrades to file search with a clear
"rebuild the index" hint. Rebuild via `init_kb.build_chroma_index()` with
`EDK2_EMBEDDING_MODEL` set.
