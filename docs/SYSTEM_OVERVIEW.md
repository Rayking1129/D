# Navos 创意素材 Hub 系统说明

更新时间：2026-08-08

## 1. 系统定位

Navos 创意素材 Hub 是一个轻量级 AI 创意素材管理系统，核心目标是把“创意制作团队”和“客户/审核团队”通过同一套飞书多维表格数据源连接起来，形成闭环：

1. 制作团队在本地制作工作台按商品生成脚本、调用视频模型生成素材。
2. 满意的素材同步到飞书素材库。
3. 客户或审核团队在线上审核系统查看最新版本素材，进行通过、建议修改、发布标记。
4. 所有商品、素材、需求、用户数据都以飞书多维表格为准。

系统目前分为两个入口：

- 线上审核系统：`index.html`，客户可访问，已部署到 Vercel。
- 本地制作工作台：`production.html`，只允许 localhost 访问，不在线上暴露。

正式线上地址：

```text
https://navos-creative-hub.vercel.app
```

本地制作台：

```text
http://localhost:8787/production.html
```

## 2. 技术栈

- 前端：原生 HTML/CSS/JavaScript，单文件页面。
- 后端：Node.js 原生 `http` server，入口为 `server.js`。
- 数据库：飞书多维表格。
- 文件存储：OSS/CDN 公网 URL。
- 部署：Vercel，`vercel.json` 将所有请求路由到 `server.js`。
- 本地服务：`npm start` 或 `node server.js`。

没有使用 React/Vue/Next.js，当前设计目标是轻量、可直接迁移、低部署成本。

## 3. 文件结构

```text
C:\Users\rayking.jin\Desktop\Nike
├─ index.html              # 线上客户审核系统
├─ production.html         # 本地制作工作台，仅 localhost 可访问
├─ server.js               # Node 后端、静态文件、飞书 API、OSS、模型 API
├─ package.json
├─ vercel.json
├─ .env.example            # 环境变量模板，可提交
├─ .env.local              # 本地真实环境变量，不要提交
├─ assets/
│  └─ navos-logo.jpg       # 系统 logo
├─ docs/
│  ├─ SYSTEM_OVERVIEW.md
│  └─ HANDOFF.md
└─ *.mp4                   # 早期本地素材文件
```

## 4. 环境变量

`.env.local` 存放真实配置，不能提交。`.env.example` 只存变量名。

必需变量：

```env
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_WIKI_TOKEN=
FEISHU_PRODUCT_TABLE_ID=
FEISHU_ASSET_TABLE_ID=
FEISHU_USER_TABLE_ID=
FEISHU_REQUEST_TABLE_ID=
OSS_UPLOAD_URL=https://app.navosagent.ai/api/matrix-base/v1/ocr/upload/file
OSS_UPLOAD_TOKEN=
OSS_UPLOAD_SUBDIR=navos/assets/briefs
MODEL_SQUARE_BASE_URL=https://open-power.tec-do.cn
MODEL_SQUARE_APP_SECRET=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat
```

注意：

- 真实密钥已经配置在本机 `.env.local`，不要复制进文档、README 或 Git。
- Vercel 上只需要配置线上审核系统使用的飞书和 OSS 变量。本地制作台虽然部署了代码，但线上会被 `isLocalRequest` 拦截。
- DeepSeek 和模型广场主要用于本地制作台。

## 5. 飞书多维表格设计

当前系统依赖同一个飞书多维表格空间，主要有四张表：

### 5.1 商品库

用途：管理可被素材、需求、制作任务关联的商品。

关键字段：

```text
商品ID
商品名称
品牌
SKU
类目
状态
封面素材URL
商品详情图URLs
商品卖点
商品规格
商品描述
参考价格
商品来源URL
创建时间
更新时间
```

前端规则：

- `状态` 为 `禁用`、`停用`、`disabled`、`inactive`、`off` 的商品不会展示。
- 商品详情图支持多个，存储为 JSON 数组。
- 制作台生成视频时会自动把商品封面和详情图作为参考图传给视频模型，最多 6 张。

### 5.2 素材库

用途：存储每个创意素材版本、审核状态、发布状态和制作来源。

关键字段：

```text
素材ID
素材名称
文件名
视频URL
版本
场景
文件大小
关联商品
审核状态
发布状态
素材标签
修改意见
审核人
审核时间
生成模型
创意脚本
生成提示词
制作人
创建时间
更新时间
```

重要规则：

- 前端默认按 `素材ID` 聚合，只展示每个素材最新版本。
- 同一个素材如果要求修改，素材 ID 不变，版本号递增，例如 `V1`、`V2`。
- 审核通过后不能再次审批，只能勾选发布状态。
- 素材列表不展示修改意见；修改意见只在详情/版本历史里看。
- 素材列表按时间倒序展示。
- 待审核用黄色状态提示，建议修改和审核通过颜色需要区分。

当前新素材创建逻辑：

- `server.js#createProductionAsset` 会读取素材表现有数字 `素材ID`，取最大值 + 1。
- 新同步素材默认 `版本 = V1`，`审核状态 = 待审核`，`发布状态 = false`。

### 5.3 用户表

用途：登录、注册、记录审核人。

关键字段：

```text
邮箱
姓名
密码哈希
盐
角色
状态
最后登录
创建时间
更新时间
```

注意：

- 当前实现使用密码哈希和盐，不存明文密码。
- 登录成功后签发 7 天有效的本地 session token。
- 前端右上角显示用户姓名，审批操作记录姓名。

### 5.4 需求列表

用途：客户提交创意需求。

关键字段：

```text
需求ID
提交人邮箱
关联商品ID
关联商品名称
创意方向
备注
需要数量
期望交付日期
附件说明
Demo参考
需求状态
创建时间
更新时间
```

前端规则：

- 商品和数量必填。
- 需要数量默认 30。
- 期望交付日期选择到天。
- 创意类型默认无强要求或产品故事类引导文案。
- 商品选择时需要展示缩略图。
- 提交后立即给用户反馈，后台异步写入。

## 6. 后端 API

所有 API 在 `server.js#handleApi`。

### 6.1 认证

```http
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

说明：

- 登录返回 `{ token, user }`。
- token 存在浏览器 localStorage，有效期 7 天。
- 后续 API 使用 `Authorization: Bearer <token>`。

### 6.2 基础数据

```http
GET /api/bootstrap
```

返回：

```json
{
  "products": [],
  "assets": [],
  "allVersionCount": 0
}
```

说明：

- 同时读取商品表和素材表。
- 商品与素材通过飞书关联字段匹配。
- 素材会按 `素材ID` 聚合，只返回最新版本，同时带 `versionHistory`。

### 6.3 素材审核

```http
PUT /api/assets/:recordId
```

用途：

- 更新审核状态。
- 更新发布状态。
- 记录审核人、审核时间、修改意见。

### 6.4 需求提交

```http
POST /api/requests
```

用途：

- 写入需求列表。

### 6.5 文件上传

```http
POST /api/uploads
```

用途：

- 接收 multipart 文件。
- 上传到 OSS。
- 返回公网 URL。

### 6.6 本地制作台 API

以下接口只允许 localhost 调用。Vercel/线上环境会返回：

```json
{ "error": "local_only" }
```

接口：

```http
POST /api/production/scripts
POST /api/production/videos
GET  /api/production/videos/:taskId
POST /api/production/assets
```

用途：

- `/scripts`：使用 DeepSeek 生成脚本；没有 key 时回退本地模板。
- `/videos`：向模型广场创建视频生成任务，支持多模型并发、多条视频。
- `/videos/:taskId`：轮询视频任务状态。
- `/assets`：将满意素材同步到飞书素材库。

## 7. 本地制作工作台设计

文件：`production.html`

目标：制作团队使用，不给客户访问。

当前流程：

1. 登录制作端。
2. 选择商品。
3. 选择创意方向，填写补充要求，只生成脚本。
4. 选中一条脚本。
5. 在视频模型区域选择多个模型。
6. 设置每模型视频数、视频时长、画面比例。
7. 点击生成视频任务。
8. 页面生成任务队列，自动轮询状态。
9. 任务完成后可预览视频。
10. 满意后点击同步到素材库，写入飞书素材表。

视频生成请求内容：

```json
{
  "model": "Seedance2.5",
  "content": [
    { "type": "text", "text": "video prompt" },
    { "type": "image_url", "image_url": { "url": "product image url" } }
  ],
  "resolution": "720p",
  "ratio": "9:16",
  "duration": 15,
  "watermark": false,
  "generateAudio": true
}
```

当前支持模型选项：

```text
Seedance2.5
Seedance2.0
Seedance2.0-fast
kling-2.5-turbo
veo-3.1-fast
MiniMax-H3
happyhorse-t2v
```

## 8. 模型接入

### 8.1 DeepSeek

用于生成创意脚本。

配置：

```env
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat
```

代码位置：

```text
server.js#generateProductionScripts
```

行为：

- 有 key：调用 DeepSeek Chat Completions。
- 无 key：走 `fallbackProductionScripts` 本地模板。

### 8.2 模型广场

用于视频生成。

配置：

```env
MODEL_SQUARE_BASE_URL=https://open-power.tec-do.cn
MODEL_SQUARE_APP_SECRET=
```

代码位置：

```text
server.js#modelSquare
server.js#createVideoTasks
server.js#getVideoTask
```

已接入接口：

```http
POST /tecpower/ai/openapi/video/create
GET  /tecpower/ai/openapi/video/task?taskId=...
```

任务状态：

```text
pending
processing
running
completed
failed
```

## 9. 线上与本地隔离

本地制作台通过 `isLocalRequest(req)` 限制访问：

```text
localhost
127.0.0.1
::1
```

并且如果检测到 `process.env.VERCEL`，一律视为非本地。

受保护资源：

```text
/production.html
/api/production/*
```

线上验证过：

```text
GET /production.html -> 404 local_only
POST /api/production/scripts -> 404 local_only
```

## 10. 部署与运行

本地运行：

```bash
npm start
```

打开：

```text
http://localhost:8787
http://localhost:8787/production.html
```

部署：

```bash
vercel --prod --yes
```

GitHub：

```text
git@github.com:Rayking1129/D.git
```

最近相关提交：

```text
fdf5928 Add local production video generation workflow
40ce5f6 Pass product images to video generation
c4bf803 Separate script and video controls in production studio
dd1634c Improve production product loading feedback
```

## 11. 已知问题与注意事项

1. 飞书 `/api/bootstrap` 有时较慢，商品加载可能需要 10 秒以上。
2. 本地制作台的视频任务队列目前只存在前端内存，刷新页面会丢失任务状态。
3. 模型生成完成后，同步飞书时目前直接使用模型返回的视频 URL；如果模型 URL 不是长期有效，应该增加“转存 OSS”步骤。
4. 飞书字段如果被重命名，后端中文字段映射会失效。
5. 商品详情图必须是公网 URL，否则视频模型无法读取参考图。
6. 当前项目是单文件前端，继续扩大会变得难维护；后续可考虑拆成 React/Vite 或 Next.js。

## 12. 推荐下一步

优先级建议：

1. 给 `/api/bootstrap` 增加 30-60 秒服务端缓存，显著加快登录后加载。
2. 新增“生成任务表”，把视频生成任务持久化到飞书或本地 SQLite，避免刷新丢失。
3. 生成视频完成后先下载/转存 OSS，再写入素材库，确保 URL 长期稳定。
4. 制作台增加商品图预览，让制作人员知道传给模型的参考图有哪些。
5. 素材版本 V2 上传流程可在制作台补齐：选择原素材 ID，创建新版本。
6. 把前端拆分模块，降低后续维护难度。
