#!/usr/bin/env python3
"""
Rerank retrieved documents using BGE-reranker-v2-m3 model.
Usage: python rerank.py <query> <json_docs>
Input: query string + JSON array of documents
Output: JSON array of reranked documents with rerank_score
"""

import sys
import json
import os
from pathlib import Path

try:
    from sentence_transformers import CrossEncoder
except ImportError:
    print(json.dumps({"error": "sentence_transformers not installed"}))
    sys.exit(1)

try:
    import torch
    _device = os.environ.get("RERANK_DEVICE",
                             "cuda" if torch.cuda.is_available() else "cpu")
except Exception:
    _device = os.environ.get("RERANK_DEVICE", "cpu")

def main():
    if len(sys.argv) != 3:
        print(json.dumps({"error": "Usage: python rerank.py <query> <json_docs>"}))
        sys.exit(1)
    
    query = sys.argv[1]
    try:
        docs = json.loads(sys.argv[2])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)
    
    if not isinstance(docs, list) or len(docs) == 0:
        print(json.dumps({"error": "Documents must be a non-empty array"}))
        sys.exit(1)
    
    # Load model
    model_path = Path.home() / ".edk2-opencode" / "models" / "bge-reranker-v2-m3"
    if not model_path.exists():
        print(json.dumps({"error": f"Model not found at {model_path}"}))
        sys.exit(1)
    
    try:
        kwargs = dict(max_length=1024, device=_device, local_files_only=True)
        if _device == "cuda":
            try:
                kwargs["precision"] = "float16"
            except Exception:
                pass
        model = CrossEncoder(str(model_path), **kwargs)
    except Exception as e:
        print(json.dumps({"error": f"Failed to load model: {e}"}))
        sys.exit(1)
    
    # Prepare pairs for reranking
    pairs = []
    for doc in docs:
        text = ""
        if doc.get("title"):
            text += doc["title"] + " "
        if doc.get("section"):
            text += doc["section"] + " "
        if doc.get("snippet"):
            text += doc["snippet"]
        elif doc.get("content"):
            text += doc["content"]
        
        # Truncate to avoid token limit
        text = text[:1000]
        pairs.append([query, text])
    
    # Rerank
    try:
        scores = model.predict(pairs, batch_size=32, convert_to_numpy=True,
                               show_progress_bar=False)
    except Exception as e:
        print(json.dumps({"error": f"Reranking failed: {e}"}))
        sys.exit(1)
    
    # Add rerank_score to docs
    for i, score in enumerate(scores):
        docs[i]["rerank_score"] = float(score)
    
    # Sort by rerank_score descending
    docs.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
    
    # Return top results
    print(json.dumps(docs[:10]))

if __name__ == "__main__":
    main()