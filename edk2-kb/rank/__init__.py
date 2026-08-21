"""Runtime hook and utilities for the trained LTR (LambdaMART) ranker.

Kept as a tiny package so search_engine.py, the label pipeline and the
trainer share one feature definition (see rank_lib.py).

Enable in the daemon with:  EDK2_LTR_MODEL=<path>/ranker.txt
"""
