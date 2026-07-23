# EDK2 RAG Service - MCP API

基于 RAG（Retrieval-Augmented Generation）技术的 EDK2 本地知识库服务，提供 MCP（Model Context Protocol）API 接口，支持关键词查询 EDK2 开发资料。

> **Note**: 本服务基于 LlamaIndex + ChromaDB 实现，兼容 WeKnorah 接口规范，可无缝替换为 Tencent/WeKnorah 框架。

## Features

- **文档自动抓取**: 从 tianocore-wiki 和 tianocore-docs 批量拉取 EDK2 文档
- **向量索引**: 使用 ChromaDB 进行高效向量存储和检索
- **语义搜索**: 基于 HuggingFace 嵌入模型的语义相似度搜索
- **MCP API**: 标准 Model Context Protocol 接口，支持与 AI Agent 集成
- **跨平台**: 支持 Windows、Linux、macOS

## Architecture

```
┌─────────────────┐
│  Document       │
│  Sources        │
│  - Wiki         │
│  - Docs Repo    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Document       │
│  Fetcher        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────┐
│  Vector Store   │────▶│  ChromaDB   │
│  (LlamaIndex)   │     │  Storage    │
└────────┬────────┘     └─────────────┘
         │
         ▼
┌─────────────────┐
│  MCP Server     │
│  (Port 8080)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AI Agent       │
│  Integration    │
└─────────────────┘
```

## Directory Structure

```
rag-service/
├── rag_service/              # Core RAG service package
│   ├── __init__.py
│   ├── config.py             # Configuration management
│   ├── document_fetcher.py   # Document fetching and parsing
│   ├── vector_store.py       # Vector indexing and retrieval
│   └── mcp_server.py         # MCP API server
├── tests/                    # Test suite
│   ├── __init__.py
│   └── test_rag_service.py
├── requirements.txt          # Python dependencies
├── setup.py                  # Package setup
├── pytest.ini                # Test configuration
├── run_server.py             # Main entry point
└── README.md                 # This file
```

## Installation

### Prerequisites

- Python 3.8+
- Git
- (Optional) CUDA-compatible GPU for faster embedding

### Install Dependencies

```bash
cd rag-service

# Create virtual environment (recommended)
python -m venv venv
source venv/bin/activate  # Linux/macOS
# or
.\venv\Scripts\activate   # Windows

# Install dependencies
pip install -r requirements.txt
```

### Install Package

```bash
pip install -e .
```

## Configuration

### Default Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `persist_directory` | `./chroma_db` | Vector database storage path |
| `embedding_model` | `all-MiniLM-L6-v2` | HuggingFace embedding model |
| `chunk_size` | `1024` | Document chunk size |
| `chunk_overlap` | `200` | Chunk overlap size |
| `top_k_results` | `5` | Number of search results |
| `mcp_server_host` | `localhost` | MCP server host |
| `mcp_server_port` | `8080` | MCP server port |

### Custom Configuration

Create `config.json`:

```json
{
  "persist_directory": "./my_vector_db",
  "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
  "chunk_size": 1024,
  "chunk_overlap": 200,
  "top_k_results": 5,
  "mcp_server_host": "localhost",
  "mcp_server_port": 8080,
  "document_sources": ["wiki", "docs"]
}
```

## Usage

### 1. Fetch Documents and Build Index

```bash
python run_server.py --fetch-docs --build-index
```

This will:
1. Clone tianocore-wiki repository
2. Clone tianocore-docs repository
3. Parse all markdown/text files
4. Create vector embeddings
5. Store in ChromaDB

### 2. Start MCP Server

```bash
python run_server.py --host localhost --port 8080
```

Or with existing index:

```bash
python run_server.py
```

### 3. Query via MCP API

#### Initialize Connection

```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "id": 1
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {},
      "resources": {}
    },
    "serverInfo": {
      "name": "edk2-rag-mcp",
      "version": "0.1.0"
    }
  },
  "id": 1
}
```

#### Search EDK2 Documents

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_edk2_docs",
    "arguments": {
      "query": "How to build OVMF?",
      "top_k": 5
    }
  },
  "id": 2
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [{
      "type": "text",
      "text": {
        "query": "How to build OVMF?",
        "total_results": 5,
        "results": [
          {
            "title": "Building OVMF",
            "score": 0.92,
            "content": "...",
            "source": "tianocore-wiki",
            "url": "https://github.com/tianocore/tianocore.github.io/wiki/Building-OVMF"
          }
        ]
      }
    }]
  },
  "id": 2
}
```

#### List Available Tools

```json
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "id": 3
}
```

### Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `search_edk2_docs` | Search EDK2 documentation | `query` (required), `top_k` (optional) |
| `get_edk2_doc_by_id` | Retrieve document by ID | `doc_id` (required) |
| `list_edk2_sources` | List available sources | None |

## Testing

### Run All Tests

```bash
cd rag-service
pytest tests/ -v
```

### Run Unit Tests Only

```bash
pytest tests/ -v -m "not integration"
```

### Run Integration Tests

```bash
pytest tests/ -v -m integration
```

### Run with Coverage

```bash
pytest tests/ --cov=rag_service --cov-report=html
```

## Python API Usage

```python
from rag_service import Config, DocumentFetcher, VectorStore, MCPServer

# Initialize
config = Config()
config.ensure_directories()

# Fetch documents
fetcher = DocumentFetcher(config)
documents = fetcher.fetch_all()

# Build vector index
vector_store = VectorStore(config)
vector_store.add_documents(documents)
vector_store.persist()

# Search
results = vector_store.similarity_search("How to use EDK2?", top_k=5)
for result in results:
    print(f"Score: {result['score']}")
    print(f"Title: {result['metadata']['title']}")
    print(f"Content: {result['content'][:200]}...")
    print("---")

# Start MCP server
server = MCPServer(config, vector_store)
server.start_socket_server()
```

## Integration with AI Agents

### OpenCode Integration

Add to `.opencode/config.json`:

```json
{
  "mcpServers": {
    "edk2-rag": {
      "command": "python",
      "args": ["/path/to/rag-service/run_server.py"],
      "env": {}
    }
  }
}
```

### Claude Desktop Integration

Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "edk2-rag": {
      "command": "python",
      "args": ["/path/to/rag-service/run_server.py"]
    }
  }
}
```

## Performance

| Metric | Value |
|--------|-------|
| Document Fetch Time | ~2-5 minutes |
| Index Build Time | ~5-10 minutes |
| Search Latency | ~100-300ms |
| Memory Usage | ~500MB-1GB |

## Troubleshooting

### Out of Memory Error

Reduce `chunk_size` or use smaller embedding model:

```json
{
  "chunk_size": 512,
  "embedding_model": "sentence-transformers/paraphrase-MiniLM-L3-v2"
}
```

### Slow Embedding

Use GPU acceleration:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu118
```

### Git Clone Timeout

Increase timeout or use shallow clone (default behavior).

## Future Enhancements

- [ ] Support for WeKnorah framework integration
- [ ] Incremental document updates
- [ ] Multi-language support
- [ ] Hybrid search (keyword + semantic)
- [ ] Document versioning
- [ ] REST API endpoint

## Contributing

1. Fork the repository
2. Create feature branch
3. Make changes
4. Run tests: `pytest tests/`
5. Submit PR

## License

MIT License

## References

- [LlamaIndex Documentation](https://docs.llamaindex.ai/)
- [ChromaDB Documentation](https://docs.trychroma.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [TianoCore Wiki](https://github.com/tianocore/tianocore.github.io/wiki)
- [TianoCore Docs](https://github.com/tianocore/docs)

## Author

Edk2Agent Team - guziqian0908