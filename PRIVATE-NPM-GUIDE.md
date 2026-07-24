# 搭建私有 NPM 仓库指南

## 方案选择

| 方案 | 难度 | 说明 | 推荐场景 |
|------|------|------|---------|
| **Verdaccio** | ⭐ 简单 | 轻量级，5分钟搭建 | ✅ 个人/小团队 |
| GitHub Packages | ⭐⭐ 中等 | 基于 GitHub | 已有 GitHub |
| Nexus | ⭐⭐⭐ 复杂 | 企业级 | 大型团队 |
| Artifactory | ⭐⭐⭐ 复杂 | 企业级 | 大型企业 |

**推荐使用 Verdaccio**（本文以 Verdaccio 为例）

---

## 方案 1: Verdaccio（推荐）

### 步骤 1: 安装 Verdaccio

```powershell
# 全局安装
npm install -g verdaccio

# 验证安装
verdaccio --version
```

### 步骤 2: 启动服务

```powershell
# 启动（默认端口 4873）
verdaccio

# 或指定端口
verdaccio --listen 5000
```

**预期输出:**

```
warn --- config file  - C:\Users\你的用户名\.config\verdaccio\config.yaml
warn --- http address - http://localhost:4873/
```

### 步骤 3: 访问 Web 界面

打开浏览器访问：http://localhost:4873

### 步骤 4: 添加用户

```powershell
# 创建第一个用户（管理员）
npm adduser --registry http://localhost:4873

# 按提示输入：
# Username: admin
# Password: your-password
# Email: your-email@example.com
```

### 步骤 5: 配置 npm 代理（可选）

```powershell
# 方式 A: 设置默认 registry
npm set registry http://localhost:4873

# 方式 B: 使用 scope（推荐，不影响公共包）
npm set @yourcompany:registry http://localhost:4873
```

---

## 方案 2: 使用 GitHub Packages

### 步骤 1: 创建 .npmrc 文件

在项目根目录创建 `.npmrc`：

```ini
@your-username:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

### 步骤 2: 创建 GitHub Token

1. 访问 https://github.com/settings/tokens
2. 创建新 Token（权限：write:packages, read:packages）
3. 设置环境变量：

```powershell
$env:GITHUB_TOKEN = "your-github-token"
```

### 步骤 3: 发布

```powershell
npm publish
```

---

## 发布 Edk2Agent 到私有仓库

### 步骤 1: 配置 package.json

更新 `package.json`：

```json
{
  "name": "@yourcompany/edk2-opencode",
  "version": "1.0.0",
  "publishConfig": {
    "registry": "http://localhost:4873",
    "access": "restricted"
  }
}
```

### 步骤 2: 创建 .npmrc

在项目根目录创建 `.npmrc`：

```ini
registry=http://localhost:4873
```

### 步骤 3: 发布

```powershell
# 登录（如果还没登录）
npm login --registry http://localhost:4873

# 发布
npm publish
```

### 步骤 4: 验证发布

```powershell
# 搜索包
npm search @yourcompany/edk2-opencode --registry http://localhost:4873

# 查看包信息
npm view @yourcompany/edk2-opencode --registry http://localhost:4873
```

---

## 其他用户安装使用

### 步骤 1: 配置 npm registry

```powershell
# 方式 A: 全局配置
npm set registry http://your-server:4873

# 方式 B: 项目级配置（创建 .npmrc）
@yourcompany:registry=http://your-server:4873
```

### 步骤 2: 登录

```powershell
npm login --registry http://your-server:4873
```

### 步骤 3: 安装使用

```powershell
# 安装
npm install -g @yourcompany/edk2-opencode

# 或使用 npx
npx @yourcompany/edk2-opencode --version
```

---

## 进阶：持久化部署（生产环境）

### 方式 1: 使用 PM2 守护进程

```powershell
# 安装 PM2
npm install -g pm2

# 启动 Verdaccio
pm2 start verdaccio -- --listen 4873

# 查看状态
pm2 status

# 设置开机自启
pm2 startup
pm2 save
```

### 方式 2: Docker 部署

```powershell
# 拉取镜像
docker pull verdaccio/verdaccio

# 运行容器
docker run -it --rm --name verdaccio -p 4873:4873 verdaccio/verdaccio

# 持久化运行
docker run -d --name verdaccio -p 4873:4873 -v /path/to/storage:/verdaccio/storage verdaccio/verdaccio
```

### 方式 3: 配置认证和权限

编辑 `~/.config/verdaccio/config.yaml`：

```yaml
auth:
  htpasswd:
    file: ./htpasswd
    max_users: 100

packages:
  '@yourcompany/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated

  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated

logs:
  type: stdout
  format: pretty
  level: warn
```

---

## 常见问题

### Q1: 如何让局域网其他用户访问？

```powershell
# 修改 config.yaml
listen: 0.0.0.0:4873

# 或启动时指定
verdaccio --listen 0.0.0.0:4873

# 其他用户访问
npm set registry http://你的IP:4873
```

### Q2: 如何配置代理（访问公共 npm）？

编辑 `config.yaml`：

```yaml
uplinks:
  npmjs:
    url: https://registry.npmjs.org/

packages:
  '@yourcompany/*':
    access: $all
    publish: $authenticated

  '**':
    access: $all
    publish: $authenticated
    proxy: npmjs
```

### Q3: 如何删除已发布的包？

```powershell
# 删除指定版本
npm unpublish @yourcompany/edk2-opencode@1.0.0 --registry http://localhost:4873

# 删除整个包
npm unpublish @yourcompany/edk2-opencode --force --registry http://localhost:4873
```

### Q4: 如何备份？

```powershell
# 备份存储目录
Copy-Item -Recurse ~/.local-share/verdaccio/storage D:\backup\verdaccio
```

---

## 快速脚本（一键部署）

创建 `setup-private-npm.ps1`：

```powershell
Write-Host "=== Setting up Private NPM Registry ===" -ForegroundColor Cyan

# 1. Install Verdaccio
Write-Host "`n[1/5] Installing Verdaccio..." -ForegroundColor Yellow
npm install -g verdaccio

# 2. Start Verdaccio (background)
Write-Host "`n[2/5] Starting Verdaccio..." -ForegroundColor Yellow
Start-Process verdaccio

# 3. Wait for server
Write-Host "`n[3/5] Waiting for server..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# 4. Add user
Write-Host "`n[4/5] Please create admin user:" -ForegroundColor Yellow
npm adduser --registry http://localhost:4873

# 5. Configure project
Write-Host "`n[5/5] Configuring project..." -ForegroundColor Yellow
"@yourcompany:registry=http://localhost:4873" | Out-File -FilePath .npmrc -Encoding utf8

Write-Host "`n=== Setup Complete ===" -ForegroundColor Green
Write-Host "Registry: http://localhost:4873" -ForegroundColor Cyan
Write-Host "Web UI:   http://localhost:4873" -ForegroundColor Cyan
Write-Host "`nTo publish: npm publish" -ForegroundColor Yellow
```

运行：

```powershell
.\setup-private-npm.ps1
```

---

## 推荐配置（生产环境）

```yaml
# ~/.config/verdaccio/config.yaml

storage: ./storage

auth:
  htpasswd:
    file: ./htpasswd
    max_users: 100

packages:
  '@yourcompany/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated

  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs

uplinks:
  npmjs:
    url: https://registry.npmjs.org/

listen: 0.0.0.0:4873

logs:
  type: stdout
  format: pretty
  level: warn
```

---

## 下一步

1. ✅ 安装并启动 Verdaccio
2. ✅ 创建管理员账号
3. ✅ 配置 package.json
4. ✅ 发布 Edk2Agent
5. ✅ 其他用户安装使用

详细文档：
- [Verdaccio 官方文档](https://verdaccio.org/)
- [GitHub Packages 文档](https://docs.github.com/en/packages)