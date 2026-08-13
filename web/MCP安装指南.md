# EDK2 RAG MCP 服务安装指南

## 这是什么

EDK2 / UEFI 知识库检索服务，以 **MCP（Model Context Protocol）** 形式运行在服务器上。
你（用户）**只需要在自己的 opencode 里配置一个远程 MCP**，即可在 opencode 里检索
EDK2 官方文档（TianoCore Wiki + EDK2 规范），**无需下载任何 EDK2 资料**。

知识库数据、向量索引、检索模型都放在服务器端，你只通过 HTTPS 调用 `search_kb`。

---

## 一、安装（只需 3 步）

### 1. 确认你已安装 opencode

命令行执行：

```bash
opencode --version
```

没有则先安装：`npm install -g opencode-ai`（或按 opencode 官方文档安装）。

### 2. 编辑 opencode.json

在你的项目目录下创建（或编辑）`opencode.json`，加入下面内容。
把 `URL` 替换成服务方发给你的 **公网 MCP URL**（形如
`https://xxxx.trycloudflare.com/mcp`）。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "edk2-kb": {
      "type": "remote",
      "url": "https://xxxx.trycloudflare.com/mcp",
      "enabled": true
    }
  }
}
```

> 也可以放到全局配置 `~/.config/opencode/opencode.json`，这样所有项目都能用。

### 3. 重启 opencode

退出并重新启动 opencode（配置只在启动时加载）。重启后 `edk2-kb` 服务会自动连接。

---

## 二、验证是否装好

在 opencode 里输入：

```
edk2-kb 服务提供的工具有哪些？列出来
```

如果正常，你会在工具列表里看到：

| 工具 | 作用 |
|------|------|
| `search_kb` | 检索 EDK2 知识库（query / top_k / source） |
| `get_kb_status` | 查看知识库状态、索引文档数、数据源 |
| `get_kb_citation_guide` | 获取基于知识库回答 EDK2 问题的规范 |

也可以直接问 EDK2 技术问题，例如：

```
PcdDebugPrintErrorLevel 是什么，怎么用？
DXE 启动流程是怎样的？
INF 文件里 [Pcds] 段怎么写？
```

opencode 会调用 `search_kb` 检索并基于结果回答。

---

## 三、常用配置项

```json
{
  "mcp": {
    "edk2-kb": {
      "type": "remote",
      "url": "https://xxxx.trycloudflare.com/mcp",
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `url` | 服务方提供的公网 MCP 端点（必须是 `.../mcp`） |
| `enabled` | 是否启用（`false` 可临时停用） |
| `timeout` | 请求超时（毫秒）。首次检索 + 重排较慢，建议 ≥ 60000 |

---

## 四、故障排查

| 现象 | 原因 / 解决 |
|------|-------------|
| 启动时报 `ConfigInvalidError` | 检查 `opencode.json` JSON 格式；`type` 必须是 `"remote"` |
| 工具列表里没有 `search_kb` | 服务未启动或 URL 过期。联系服务方更新 URL |
| 调用超时 | 首次加载模型较慢，把 `timeout` 调大到 120000 |
| 隧道地址变了 | trycloudflare 地址是临时的，重启服务端脚本后会更换，需用新 URL 更新配置 |

---

## 五、隐私与安全提示

- 你输入的问题会被发送到服务端进行检索，请勿提交敏感信息。
- 该服务为只读检索，不会读取你本地任何文件。
