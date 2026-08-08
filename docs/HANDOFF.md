# Navos 创意素材 Hub 交接文档

这份文档给下一位接手的模型或工程师使用。目标是：看到这里就能理解系统现状、不要踩坑、知道下一步怎么改。

## 1. 当前一句话总结

这是一个以飞书多维表格为后端数据库的 AI 创意素材管理系统。客户线上使用 `index.html` 审核素材；制作团队本地使用 `production.html` 按商品生成脚本、调用视频模型生成素材，并把满意素材同步回同一张飞书素材库。

## 2. 你接手时先做什么

先在项目目录运行：

```bash
git status --short
node --check server.js
node -e "const fs=require('fs'); for (const f of ['index.html','production.html']) { const html=fs.readFileSync(f,'utf8'); const scripts=[...html.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]); scripts.forEach((s)=>new Function(s)); console.log(f, 'ok'); }"
npm start
```

本地访问：

```text
http://localhost:8787
http://localhost:8787/production.html
```

客户线上地址：

```text
https://navos-creative-hub.vercel.app
```

## 3. 不要做的事

非常重要：

- 不要把 `.env.local` 提交到 Git。
- 不要把用户给的真实 API key 写进 README、docs、代码注释或提交记录。
- 不要把 `production.html` 暴露到线上。
- 不要改掉 `isLocalRequest` 对 Vercel 的拦截逻辑，除非用户明确要求制作台也上线。
- 不要重置 Git 或回滚用户未确认的改动。
- 不要用本地 `file:///.../index.html` 测试 API 功能，必须通过 `http://localhost:8787`。

## 4. 当前关键文件

```text
index.html
```

线上客户审核系统。包括登录、商品库、素材库、需求列表、审核台账、素材详情抽屉、版本历史等 UI 和交互。

```text
production.html
```

本地制作工作台。包括登录、商品选择、DeepSeek 脚本生成、模型广场视频生成、生成队列、手动上传、同步素材库。

```text
server.js
```

所有后端逻辑：

- 静态文件服务
- 飞书 tenant token
- 飞书 Wiki token 转 Bitable app_token
- 表记录读写
- 用户注册登录/session
- OSS 上传
- 素材审核
- 需求提交
- 本地制作台 API
- DeepSeek
- 模型广场

```text
.env.example
```

环境变量模板。

```text
.env.local
```

本机真实环境变量，已经配置过飞书、OSS、DeepSeek、模型广场。不要查看后复制到文档，不要提交。

## 5. 当前业务模块

### 5.1 登录

后端：

```text
POST /api/auth/login
POST /api/auth/register
GET /api/auth/me
POST /api/auth/logout
```

说明：

- session token 有效期 7 天。
- 用户表里记录姓名。
- 审批操作用当前登录用户姓名作为审核人。
- 当前代码是哈希密码，不是明文密码。

### 5.2 商品库

商品来自飞书商品表。

前端只展示启用商品。禁用商品不会展示，也不能筛选。

商品图字段：

```text
封面素材URL
商品详情图URLs
```

视频生成时使用商品图：

```text
product.cover + product.detailImages
```

最多传 6 张给模型。

### 5.3 素材库

素材来自飞书素材表。

规则：

- 用 `素材ID` 聚合版本。
- 默认展示最新版本。
- 版本号 `V1`、`V2`。
- 审核通过后不能再次审批，只能更新发布状态。
- 修改意见只在详情页/版本历史里展示。

### 5.4 需求列表

客户提交需求，写入飞书需求表。

规则：

- 商品必填。
- 数量必填，默认 30。
- 创意方向、备注、Demo、附件说明、交付日期选填。

### 5.5 本地制作台

入口：

```text
http://localhost:8787/production.html
```

第一步：生成脚本，只包含脚本参数。

```text
选择商品
创意方向
脚本数量
补充要求
```

第二步：生成视频，才包含视频参数。

```text
视频模型多选
每模型视频数
视频时长
画面比例
```

当前商品加载体验已经优化：

- 未登录：显示“请先登录后选择商品”
- 登录后：显示“商品加载中...”
- 5 秒以上：显示“商品加载较慢，请稍等或点击刷新”
- 有独立“刷新”按钮

## 6. API 路由速查

```text
GET  /api/auth/me
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/bootstrap
POST /api/uploads
POST /api/requests
PUT  /api/assets/:recordId
POST /api/production/assets       # local only
POST /api/production/scripts      # local only
POST /api/production/videos       # local only
GET  /api/production/videos/:id   # local only
```

## 7. 模型接入现状

### 7.1 DeepSeek

位置：

```text
server.js#generateProductionScripts
```

作用：

- 根据商品、创意方向、补充要求生成脚本和视频 prompt。
- 返回 JSON：`{ scripts: [{ title, script, prompt }] }`。
- 如果 DeepSeek key 不存在，使用本地模板兜底。

### 7.2 模型广场

位置：

```text
server.js#modelSquare
server.js#createVideoTasks
server.js#getVideoTask
```

创建任务：

```text
POST /tecpower/ai/openapi/video/create
```

查询任务：

```text
GET /tecpower/ai/openapi/video/task?taskId=...
```

认证头：

```text
X-App-Secret
```

注意：

- `createVideoTasks` 使用 `Promise.allSettled` 并发创建任务。
- 单个模型失败不会影响其他模型返回。
- `normalizeVideoTask` 会从多种可能字段中提取视频 URL。

## 8. 飞书字段映射风险

这是当前最大维护风险之一。

`server.js` 里大量字段名是中文硬编码，例如：

```text
商品ID
商品名称
素材ID
审核状态
发布状态
修改意见
创建时间
更新时间
```

如果飞书字段改名，接口会读不到数据。接手后如果发现前端数据异常，先检查飞书字段名是否变了。

## 9. 当前已知问题

### 9.1 商品加载慢

现象：

- 登录后商品可能 10 秒以上才加载出来。

原因：

- `/api/bootstrap` 每次实时读飞书商品表和素材表。

建议：

- 在 `getBootstrap` 外层加短缓存。
- 例如缓存 30-60 秒，审核更新后主动失效或前端刷新时绕过缓存。

### 9.2 视频任务不持久化

现象：

- 本地制作台刷新页面后，生成任务队列丢失。

原因：

- 当前任务存在前端 `state.tasks` 内存里。

建议：

- 新建“生成任务表”或用本地 SQLite/JSON 存储。
- 字段可包括：任务ID、商品ID、模型、脚本、prompt、状态、视频URL、创建人、创建时间、更新时间。

### 9.3 模型视频 URL 未转存 OSS

现象：

- 模型完成后同步素材库时，直接写模型返回 URL。

风险：

- 如果模型 URL 过期，客户审核时视频可能打不开。

建议：

- 完成后由后端下载视频，再通过 `/api/uploads` 的 OSS 逻辑转存，最后把 OSS URL 写入素材库。

### 9.4 前端逐渐变大

现象：

- `index.html` 已经很大，`production.html` 也在增长。

建议：

- 后续如果继续扩展，拆成 Vite/React 或至少拆 JS 模块。

## 10. 常用验证命令

语法：

```bash
node --check server.js
node -e "const fs=require('fs'); for (const f of ['index.html','production.html']) { const html=fs.readFileSync(f,'utf8'); const scripts=[...html.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]); scripts.forEach((s)=>new Function(s)); console.log(f, 'ok'); }"
```

本地制作台隔离：

```bash
node - <<'NODE'
process.env.VERCEL='1';
const http = require('http');
const handler = require('./server');
const server = http.createServer(handler);
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(await (await fetch(`${base}/production.html`)).text());
  server.close();
});
NODE
```

部署：

```bash
vercel --prod --yes
```

线上确认：

```text
https://navos-creative-hub.vercel.app
https://navos-creative-hub.vercel.app/production.html
```

预期：

```text
/production.html -> 404 local_only
```

## 11. 下一个模型可直接使用的交接 Prompt

可以把下面这段直接发给下一个模型：

```text
你正在接手 C:\Users\rayking.jin\Desktop\Nike 项目。它是 Navos 创意素材 Hub，一个飞书多维表格驱动的 AI 创意素材管理系统。

请先阅读：
- docs/SYSTEM_OVERVIEW.md
- docs/HANDOFF.md
- server.js
- index.html
- production.html

当前架构：
- index.html 是线上客户审核系统，部署在 https://navos-creative-hub.vercel.app
- production.html 是本地制作工作台，只允许 localhost 访问
- server.js 是 Node 原生后端，包含飞书、OSS、DeepSeek、模型广场 API
- 飞书是唯一后端数据库
- .env.local 有真实密钥，但不能提交，不能写入文档

当前重要规则：
- 线上不能暴露 production.html 或 /api/production/*
- 商品状态为禁用/停用/disabled/inactive/off 时不展示
- 素材按素材ID聚合，默认展示最新版本
- 同一素材修改时素材ID不变，版本号递增
- 审核通过后不能再次审批，只能更新发布状态
- 制作台生成视频时必须把商品封面图和详情图作为 image_url 参考图传给模型

修改代码后必须至少运行：
- node --check server.js
- 检查 index.html/production.html 内联 script 能被 new Function 解析
- 如涉及线上，部署后确认 /production.html 返回 404 local_only

不要把 .env.local、真实 key、token 提交或写进文档。
```

## 12. 最近提交记录

```text
fdf5928 Add local production video generation workflow
40ce5f6 Pass product images to video generation
c4bf803 Separate script and video controls in production studio
dd1634c Improve production product loading feedback
```
