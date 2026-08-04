# EDK2 KB Retrieval Evaluation

Date: 2026-08-04  Queries: 220  top_k: 10

## All queries

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 49.5% | 0.468 |
| bm25 | 28.6% | 0.249 |
| hybrid | 56.8% | 0.502 |
| hybrid+rerank | 57.3% | 0.527 |

## Manual labeled questions

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 50.0% | 0.429 |
| bm25 | 25.0% | 0.2 |
| hybrid | 55.0% | 0.459 |
| hybrid+rerank | 60.0% | 0.439 |

## Auto title questions

| baseline | hit@5 | MRR@10 |
|---|---|---|
| vector | 49.5% | 0.472 |
| bm25 | 29.0% | 0.254 |
| hybrid | 57.0% | 0.507 |
| hybrid+rerank | 57.0% | 0.536 |
