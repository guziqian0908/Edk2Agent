# EDK2-OpenCode v6.0.0 Test Cases

## 1. 动态端口测试（无固定端口冲突）

**目的**: 验证不再使用固定 9876 端口，端口由 OS 动态分配

**测试步骤**:
```bash
# 检查 9876 是否被占用（应与本工具无关）
netstat -ano | findstr "9876"

# 启动 daemon
npx edk2-opencode daemon start

# 查看 daemon.json 中的实际端口（应是动态端口）
Get-Content "$env:USERPROFILE\.edk2-opencode\kb\daemon.json"
```

**预期结果**:
- daemon.json 中 `port` 是动态端口（非 9876）
- 每次重启端口可能不同，但 `daemon.json` 始终记录当前端点

---

## 2. daemon 生命周期测试

**目的**: 验证 daemon start/status/stop 正常

**测试步骤**:
```bash
npx edk2-opencode daemon start
npx edk2-opencode daemon status
npx edk2-opencode daemon stop
npx edk2-opencode daemon status
```

**预期结果**:
- `start` 输出 "Daemon running at http://127.0.0.1:PORT"
- `status` 显示 Running / PID / Watchdog PID / Ready / Indexed Documents
- `stop` 输出 "Daemon stopped."，之后 status 显示 Not running
- 停止后 daemon.json 被清理

---

## 3. 崩溃自动恢复测试

**目的**: 验证 server 进程崩溃后 watchdog 自动重启

**测试步骤**:
```bash
# 启动 daemon 并记录 server PID
npx edk2-opencode daemon start
$s = Get-Content "$env:USERPROFILE\.edk2-opencode\kb\daemon.json" -Raw | ConvertFrom-Json
$oldPid = $s.pid

# 强制杀死 server 进程
Stop-Process -Id $oldPid -Force

# 等待几秒后再次查看状态
Start-Sleep -Seconds 5
npx edk2-opencode daemon status
```

**预期结果**:
- 新 server 自动重启（PID 变化，端口可能变化）
- `/health` 恢复响应
- supervisor 日志记录 "MCP server exited unexpectedly ... restarting"
- 搜索功能自动恢复，无需手动干预

---

## 4. 多实例共享测试

**目的**: 验证多个 OpenCode/多次调用共享同一 daemon，不重复启动

**测试步骤**:
```bash
npx edk2-opencode daemon start
npx edk2-opencode --search "PCD"
npx edk2-opencode --search "INF file"
npx edk2-opencode daemon status
```

**预期结果**:
- 多次调用只存在一个 daemon（watchdog PID 不变）
- 每次 `--search` 直接复用已有 daemon，无端口冲突
- daemon.json 中的端口保持稳定

---

## 5. MCP 服务测试

**目的**: 验证 OpenCode 中可用的 MCP 工具

**测试步骤**:
```bash
npx edk2-opencode daemon start

# 检查生成的 opencode.json 含 mcp.edk2-kb 配置
Get-Content opencode.json

# 启动 OpenCode 后询问
npx edk2-opencode
# 在对话中: "你能用 edk2-kb 的哪些工具？"
```

**预期结果**:
- `opencode.json` 的 `mcp.edk2-kb` 配置为 `type: "remote"`，URL 指向
  `http://127.0.0.1:动态端口/mcp`
- OpenCode 中可用 `edk2-kb_search_kb` 与 `edk2-kb_get_kb_status`
- 让模型搜索 "PCD" 能返回带来源标注的结果

---

## 6. 双数据源检索测试

**目的**: 验证可同时检索 TianoCore Wiki 和 tianocore-docs

**测试步骤**:
```bash
npx edk2-opencode --search "PCD"
npx edk2-opencode --search "INF file"
npx edk2-opencode --search "UEFI driver"
```

**预期结果**:
- 返回结果包含 `source_display` 字段
- 来源标注为 "TianoCore Wiki (官网)" 或 "tianocore-docs (仓库)"
- 两套数据源均有命中

---

## 7. 初始化与更新测试

**测试步骤**:
```bash
# 全量初始化（首次）
npx edk2-opencode --init-edk2-wiki

# 增量更新
npx edk2-opencode --init-edk2-wiki --update
```

**预期结果**:
- 全量初始化后 `~/.edk2-opencode/kb/data/` 包含:
  - `tianocore-wiki/`（HTML）
  - `tianocore-docs/repo/`（Markdown）
  - `chroma_db/`（向量索引）
- 增量更新仅同步变更内容
- 初始化会同步 `search_engine.py`（供 CLI 兼容使用）

---

## 8. 离线模式测试

**目的**: 验证运行阶段不发起外网请求

**测试步骤**:
```bash
# 1. 初始化（需要网络）
npx edk2-opencode --init-edk2-wiki

# 2. 断开网络后搜索
npx edk2-opencode --search "PCD"
```

**预期结果**:
- 断网后搜索仍然成功（ChromaDB 本地向量检索）
- 无网络错误

---

## 9. 日志查看

**测试步骤**:
```bash
npx edk2-opencode daemon start
npx edk2-opencode daemon logs
```

**预期结果**:
- 显示 supervisor 日志（启动、重启、退出事件）
- 日志路径: `~/.edk2-opencode/kb/logs/mcp-supervisor.log`

---

## 测试命令汇总

```bash
# 1. daemon 生命周期
npx edk2-opencode daemon start
npx edk2-opencode daemon status
npx edk2-opencode daemon stop

# 2. 搜索
npx edk2-opencode --search "PCD"

# 3. 崩溃恢复
#    手动杀死 server PID 后执行 daemon status 观察自动重启

# 4. 全量初始化
npx edk2-opencode --init-edk2-wiki

# 5. 增量更新
npx edk2-opencode --init-edk2-wiki --update
```
