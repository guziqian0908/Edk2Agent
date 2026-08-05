# EDK2 KB Retrieval Evaluation

Date: 2026-08-04  Queries: 330  top_k: 10

## All queries

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 48.8% | 0.46 |
| bm25 | 27.6% | 0.247 |
| hybrid | 55.2% | 0.463 |
| hybrid+rerank | 57.0% | 0.514 |

## Manual labeled questions

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 46.9% | 0.426 |
| bm25 | 26.2% | 0.237 |
| hybrid | 52.3% | 0.395 |
| hybrid+rerank | 56.9% | 0.484 |

## Auto title questions

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 50.0% | 0.482 |
| bm25 | 28.5% | 0.254 |
| hybrid | 57.0% | 0.507 |
| hybrid+rerank | 57.0% | 0.535 |

## Reranker comparison

Manual set (130 labeled), hit@5 / MRR@10 for hybrid and hybrid+rerank:

| reranker | hybrid hit@5 | hybrid MRR | +rerank hit@5 | +rerank MRR |
|---|---|---|---|---|
| (no rerank) | 52.3% | 0.395 | -- | -- |
| ms-marco-MiniLM-L-6-v2 | 52.3% | 0.395 | 56.2% | 0.494 |
| **bge-reranker-v2-m3** | 52.3% | 0.395 | 56.9% | 0.484 |

Chinese subset (8 queries, top-10 pool): rerank hit@5 12.5% for both
bge-v2-m3 and ms-marco - recall there is capped by retrieval, not reranking.
English-only subset: 59.8% (bge) vs 59.0% (ms-marco).

bge-v2-m3 is the default because its sigmoid scores map faithfully to
confidence on non-English queries (a correct Chinese doc scores `high` under
bge vs `low` under ms-marco), which is what the LLM relies on to decide how
firmly to assert.

**Caveat / next step:** Chinese recall is still weak overall - the bottleneck
is *retrieval* (English-only all-MiniLM-L6-v2 embedder plus weak Chinese
BM25), so the correct doc often never enters the rerank pool. Switch the
embedder to the already-cached BAAI/bge-m3 and re-run.
