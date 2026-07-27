---
name: tianocore-wiki-mcp
description: WeKnora-style RAG service for TianoCore EDK II documentation. Provides semantic search, document chunking, and hybrid search capabilities. Use when user asks about EDK II development, UEFI/PI specifications, or TianoCore documentation.
---

# TianoCore Wiki MCP Service - WeKnora-style RAG

Provides EDK II documentation through MCP with WeKnora-inspired RAG architecture.

## Architecture

This service implements a lightweight RAG (Retrieval-Augmented Generation) system inspired by Tencent WeKnora:

```
┌─────────────────────────────────────────────────────┐
│                   MCP Server                         │
│  ┌───────────────┬─────────────────────────────┐   │
│  │  Tool APIs    │  hybrid_search               │   │
│  │               │  semantic_search             │   │
│  │               │  get_document                │   │
│  │               │  get_chunk                   │   │
│  │               │  list_sources                │   │
│  │               │  get_stats                   │   │
│  └───────────────┴─────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│                   RAG Engine                         │
│  ┌───────────────┬─────────────────────────────┐   │
│  │  Hybrid       │  Vector Search              │   │
│  │  Search       │  (TF-IDF embeddings)        │   │
│  │  Engine       │  Keyword Search             │   │
│  │               │  Result Ranking             │   │
│  └───────────────┴─────────────────────────────┘   │
│  ┌───────────────┬─────────────────────────────┐   │
│  │  Text         │  Chunking                   │   │
│  │  Chunker      │  (configurable size)        │   │
│  └───────────────┴─────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│               Knowledge Base                         │
│  ┌───────────────┬─────────────────────────────┐   │
│  │  TianoCore    │  Development guides          │   │
│  │  Wiki         │  Platform docs               │   │
│  │               │  Tutorials                   │   │
│  ├───────────────┼─────────────────────────────┤   │
│  │  TianoCore    │  UEFI Specification          │   │
│  │  Docs         │  PI Specification            │   │
│  │               │  DEC specs                   │   │
│  └───────────────┴─────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## WeKnora Reference

This implementation draws inspiration from Tencent WeKnora's RAG architecture:

- **Document Chunking**: Configurable chunk size and overlap
- **Vector Embeddings**: TF-IDF based semantic vectors
- **Hybrid Search**: Combines vector similarity and keyword matching
- **Knowledge Management**: Multi-source document indexing

For full WeKnora features (vector databases, multi-model support, distributed deployment), see:
https://github.com/Tencent/WeKnora

## Data Sources

1. **TianoCore Wiki** (`tianocore-wiki`)
   - URL: https://www.tianocore.org/tianocore-wiki.github.io/
   - Content: Development guides, tutorials, platform documentation

2. **TianoCore Docs** (`tianocore-docs`)
   - URL: https://github.com/tianocore-docs
   - Content: UEFI/PI specifications, DEC file specs

## MCP Tools

### hybrid_search

Combined vector + keyword search:

```json
{
  "name": "hybrid_search",
  "arguments": {
    "query": "UEFI driver binding protocol",
    "top_k": 10,
    "vector_threshold": 0.3,
    "keyword_threshold": 0.1,
    "source": "tianocore-docs"
  }
}
```

Returns: Chunks with combined scores

### semantic_search

Pure semantic similarity:

```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "memory allocation in UEFI",
    "top_k": 5,
    "threshold": 0.5
  }
}
```

Returns: Ranked chunks by similarity

### get_document

Full document retrieval:

```json
{
  "name": "get_document",
  "arguments": {
    "doc_id": "platforms-packages/platform-ports/ovmf"
  }
}
```

### get_chunk

Specific chunk by ID:

```json
{
  "name": "get_chunk",
  "arguments": {
    "chunk_id": "abc123def456"
  }
}
```

### list_sources

Available data sources:

```json
{
  "name": "list_sources",
  "arguments": {}
}
```

### get_stats

RAG engine statistics:

```json
{
  "name": "get_stats",
  "arguments": {}
}
```

## Configuration

### OpenCode MCP Config

```json
{
  "mcpServers": {
    "tianocore-wiki": {
      "command": "python",
      "args": [".opencode/skills/tianocore-wiki-mcp/mcp_server.py"]
    }
  }
}
```

### Chunking Config (in rag_engine.py)

```python
ChunkingConfig(
    chunk_size=1024,      # Characters per chunk
    chunk_overlap=200,    # Overlap between chunks
    separators=["\n\n", "\n", ".", " "]
)
```

## Usage Example

```python
# Query EDK II documentation
# User: "How do I build OVMF?"

# MCP calls hybrid_search:
{
  "query": "How do I build OVMF?",
  "top_k": 5
}

# Returns:
{
  "total_results": 3,
  "results": [
    {
      "chunk_id": "a1b2c3d4e5f6",
      "title": "Building OVMF",
      "snippet": "To build OVMF, you need to...",
      "source": "tianocore-wiki",
      "scores": {
        "vector": 0.85,
        "keyword": 0.67,
        "combined": 0.79
      }
    }
  ]
}
```

## Updating Knowledge Base

```bash
# Fetch and index documentation
python fetch_wiki.py

# Rebuild RAG index
python mcp_server.py --rebuild-index

# Check statistics
python mcp_server.py --stats
```

## Performance

| Metric | Value |
|--------|-------|
| Search Latency | 50-200ms |
| Index Build Time | 1-5 min |
| Memory Usage | 100-500MB |

## Comparison with WeKnora

| Feature | WeKnora | This Service |
|---------|---------|--------------|
| Vector DB | PostgreSQL/pgvector/Milvus | In-memory TF-IDF |
| Embeddings | HuggingFace/OpenAI | TF-IDF vectors |
| Deployment | Docker/K8s | Single Python file |
| Models | Multi-model support | TF-IDF only |
| Knowledge Graph | Neo4j | Text chunks |

## Upgrading to WeKnora

For production use cases requiring:
- Persistent vector storage
- Multiple embedding models
- Distributed deployment
- Knowledge graph integration

Deploy full WeKnora: https://github.com/Tencent/WeKnora

## Testing

```bash
# Run test suite
python tests/test_mcp_service.py

# Verbose output
python tests/test_mcp_service.py -v
```

## References

- [WeKnora GitHub](https://github.com/Tencent/WeKnora)
- [WeKnora MCP Server](https://github.com/Tencent/WeKnora/tree/main/mcp-server)
- [TianoCore Wiki](https://www.tianocore.org/tianocore-wiki.github.io/)
- [MCP Protocol](https://modelcontextprotocol.io/)