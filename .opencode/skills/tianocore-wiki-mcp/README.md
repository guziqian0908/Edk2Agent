# TianoCore Wiki MCP Service - WeKnora-style RAG

基于 WeKnora 架构的 EDK II 文档 MCP 服务，为 OpenCode 提供语义搜索能力。

> **架构参考**: 本服务采用腾讯 [WeKnora](https://github.com/Tencent/WeKnora) 的 RAG 设计理念，实现轻量级语义搜索方案。

## 核心特性

### WeKnora-style RAG 架构

| 特性 | 说明 |
|------|------|
| **文档分块** | 智能文本分块，支持配置块大小和重叠 |
| **向量索引** | TF-IDF 向量嵌入，支持语义相似度搜索 |
| **混合搜索** | 结合向量搜索和关键词匹配，提高召回率 |
| **知识库管理** | 支持多数据源，自动索引更新 |

### 与 WeKnora 的关系

```
WeKnora (完整方案)          本服务 (轻量方案)
─────────────────          ─────────────────
完整 RAG 平台              单文件 MCP 服务
向量数据库存储             内存向量索引
多模型支持                 TF-IDF 嵌入
分布式部署                 本地运行
知识图谱                   文档分块
Web UI                     MCP 协议
```

## 数据源

| 数据源 | 说明 | URL |
|--------|------|-----|
| TianoCore Wiki | EDK II 开发文档、教程、指南 | https://www.tianocore.org/tianocore-wiki.github.io/ |
| TianoCore Docs | UEFI/PI 规范和技术文档 | https://github.com/tianocore-docs |

## 安装

### 1. 初始化知识库

```bash
# 抓取示例页面（推荐）
python .opencode/skills/tianocore-wiki-mcp/fetch_wiki.py --sample

# 抓取完整文档（需要较长时间）
python .opencode/skills/tianocore-wiki-mcp/fetch_wiki.py
```

### 2. 配置 OpenCode

在项目根目录的 `opencode.json` 添加：

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

## MCP 工具

### hybrid_search

混合搜索（向量 + 关键词）：

```json
{
  "name": "hybrid_search",
  "arguments": {
    "query": "How to build OVMF?",
    "top_k": 10,
    "vector_threshold": 0.3,
    "keyword_threshold": 0.1,
    "source": "tianocore-wiki"
  }
}
```

参数说明：
- `query`: 搜索关键词
- `top_k`: 返回结果数量（默认 10）
- `vector_threshold`: 向量相似度阈值（0.0-1.0）
- `keyword_threshold`: 关键词匹配阈值（0.0-1.0）
- `source`: 可选，按来源过滤

### semantic_search

纯语义搜索：

```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "UEFI driver development",
    "top_k": 5,
    "threshold": 0.5
  }
}
```

### get_document

获取完整文档：

```json
{
  "name": "get_document",
  "arguments": {
    "doc_id": "development/tutorials-howto/getting_started_with_edk_ii"
  }
}
```

### get_chunk

获取特定分块：

```json
{
  "name": "get_chunk",
  "arguments": {
    "chunk_id": "abc123def456"
  }
}
```

### list_sources

列出数据源：

```json
{
  "name": "list_sources",
  "arguments": {}
}
```

### get_stats

获取统计信息：

```json
{
  "name": "get_stats",
  "arguments": {}
}
```

## 架构说明

### RAG 流程

```
用户查询 → MCP Server → 混合搜索引擎
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
              向量搜索            关键词搜索
                    ↓                   ↓
              相似度计算          匹配度计算
                    └─────────┬─────────┘
                              ↓
                         结果合并排序
                              ↓
                         返回 Top-K
```

### 文档处理

```
原始文档 → 文本分块器 → 生成向量嵌入 → 存入向量索引
             ↓
     配置参数：
     - chunk_size: 1024
     - chunk_overlap: 200
     - separators: ["\n\n", "\n", ".", " "]
```

## 性能特性

| 指标 | 值 |
|------|-----|
| 内存使用 | ~100-500MB |
| 搜索延迟 | ~50-200ms |
| 索引构建 | ~1-5 分钟 |

## 扩展到完整 WeKnora

如需更强大的功能（如持久化向量数据库、多模型支持），可参考 WeKnora 部署：

1. 部署 WeKnora 后端服务
2. 导入 TianoCore 文档到 WeKnora 知识库
3. 使用 WeKnora MCP Server 连接后端

详见：https://github.com/Tencent/WeKnora/tree/main/mcp-server

## 目录结构

```
.opencode/skills/tianocore-wiki-mcp/
── mcp_server.py      # MCP 服务器
├── rag_engine.py     # RAG 引擎（WeKnora-style）
├── fetch_wiki.py     # 文档抓取脚本
├── SKILL.md          # 技能描述
├── README.md         # 本文档
└── knowledge/        # 知识库目录
    ├── wiki_index.json   # 文档索引
    └── rag_state.json    # RAG 状态缓存
```

## 命令行选项

```bash
# 启动 MCP 服务器
python mcp_server.py

# 抓取文档
python mcp_server.py --fetch

# 重建索引
python mcp_server.py --rebuild-index

# 查看统计
python mcp_server.py --stats
```

## 测试

```bash
# 运行测试
python tests/test_mcp_service.py

# 详细测试报告
python tests/test_mcp_service.py -v
```

## 参考资料

- [WeKnora 项目](https://github.com/Tencent/WeKnora) - 腾讯开源知识管理平台
- [TianoCore Wiki](https://www.tianocore.org/tianocore-wiki.github.io/)
- [MCP 协议](https://modelcontextprotocol.io/)
- [LlamaIndex 文档](https://docs.llamaindex.ai/)