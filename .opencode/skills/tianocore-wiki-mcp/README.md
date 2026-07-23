# TianoCore Wiki MCP Service

EDK II 开发文档 MCP 服务，为 OpenCode 提供 TianoCore 知识库访问能力。

## 功能

- **文档搜索**: 全文搜索 EDK II 开发文档
- **页面获取**: 获取完整的 wiki 页面内容
- **分类浏览**: 按主题浏览文档

## 安装

### 1. 初始化知识库

首次使用需要抓取 wiki 内容：

```bash
# 抓取完整 wiki（需要较长时间）
python .opencode/skills/tianocore-wiki-mcp/fetch_wiki.py

# 或仅抓取示例页面（推荐测试）
python .opencode/skills/tianocore-wiki-mcp/fetch_wiki.py --sample
```

### 2. 配置 OpenCode

在项目根目录创建或编辑 `opencode.json`：

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

### 3. 使用

启动 OpenCode 后，可以直接对话查询 EDK II 相关问题：

```
用户: 如何开始使用 EDK II？
OpenCode: [通过 MCP 搜索文档并返回相关内容]
```

## 可用工具

### search_wiki

搜索 EDK II 文档：

```json
{
  "name": "search_wiki",
  "arguments": {
    "query": "getting started",
    "limit": 10
  }
}
```

### get_wiki_page

获取完整页面内容：

```json
{
  "name": "get_wiki_page",
  "arguments": {
    "path": "development/tutorials-howto/getting_started_with_edk_ii"
  }
}
```

### list_categories

列出文档分类：

```json
{
  "name": "list_categories",
  "arguments": {}
}
```

## 知识库内容

| 分类 | 内容 |
|------|------|
| Getting Started | EDK II 入门指南 |
| Development | 开发教程和贡献指南 |
| Platforms | OVMF、EmulatorPkg 等平台文档 |
| Specifications | UEFI/PI 规范说明 |
| Community | 社区支持和报告指南 |

## 目录结构

```
.opencode/skills/tianocore-wiki-mcp/
├── SKILL.md           # 技能描述
├── mcp_server.py      # MCP 服务器
├── fetch_wiki.py      # 知识库抓取脚本
├── README.md          # 本文档
└── knowledge/         # 知识库目录
    └── wiki_index.json
```

## 更新知识库

定期更新以获取最新文档：

```bash
python .opencode/skills/tianocore-wiki-mcp/fetch_wiki.py
```

## 参考资料

- [TianoCore Wiki](https://www.tianocore.org/tianocore-wiki.github.io/)
- [EDK II Repository](https://github.com/tianocore/edk2)
- [MCP 协议](https://modelcontextprotocol.io/)