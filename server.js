const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;

loadLocalEnv();

const CONFIG = {
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  wikiToken: process.env.FEISHU_WIKI_TOKEN,
  productTableId: process.env.FEISHU_PRODUCT_TABLE_ID,
  assetTableId: process.env.FEISHU_ASSET_TABLE_ID,
  userTableId: process.env.FEISHU_USER_TABLE_ID,
  requestTableId: process.env.FEISHU_REQUEST_TABLE_ID
};

const OSS_CONFIG = {
  uploadUrl: process.env.OSS_UPLOAD_URL || "https://app.navosagent.ai/api/matrix-base/v1/ocr/upload/file",
  token: process.env.OSS_UPLOAD_TOKEN,
  subDir: process.env.OSS_UPLOAD_SUBDIR || "navos/assets/briefs"
};

const MODEL_CONFIG = {
  baseUrl: process.env.MODEL_SQUARE_BASE_URL || "https://open-power.tec-do.cn",
  appSecret: process.env.MODEL_SQUARE_APP_SECRET,
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  pixverseBaseUrl: process.env.PIXVERSE_BASE_URL || "https://app-api.pixverse.ai",
  pixverseApiKey: process.env.PIXVERSE_API_KEY
};

let tenantTokenCache = null;
let appTokenCache = null;
let userRecordsCache = null;
let skillsCache = null;
const sessions = new Map();
const TASKS_FILE = path.join(ROOT, "tasks.json");
const BATCHES_FILE = path.join(ROOT, "batches.json");

function loadLocalEnv() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function assertConfig() {
  const missing = Object.entries(CONFIG).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new Error(`missing config: ${missing.join(", ")}`);
  }
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json; charset=utf-8"
  };
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: "not_found" });
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function feishu(pathname, options = {}) {
  assertConfig();
  const resp = await fetch(`https://open.feishu.cn/open-apis${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers || {})
    }
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`${data.code}: ${data.msg}`);
  }
  return data;
}

async function feishuWithRetry(pathname, options = {}, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await feishu(pathname, options);
    } catch (error) {
      lastError = error;
      if (!/1254607|Data not ready/i.test(error.message) || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getTenantToken() {
  const now = Date.now();
  if (tenantTokenCache && tenantTokenCache.expiresAt > now + 60000) {
    return tenantTokenCache.token;
  }
  const data = await feishu("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({
      app_id: CONFIG.appId,
      app_secret: CONFIG.appSecret
    })
  });
  tenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, data.expire - 300) * 1000
  };
  return tenantTokenCache.token;
}

async function getAppToken() {
  if (appTokenCache) return appTokenCache;
  const token = await getTenantToken();
  const data = await feishu(`/wiki/v2/spaces/get_node?token=${encodeURIComponent(CONFIG.wikiToken)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (data.data.node.obj_type !== "bitable") {
    throw new Error(`wiki node is ${data.data.node.obj_type}, not bitable`);
  }
  appTokenCache = data.data.node.obj_token;
  return appTokenCache;
}

async function listRecords(tableId) {
  const token = await getTenantToken();
  const appToken = await getAppToken();
  const items = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({ page_size: "500" });
    if (pageToken) qs.set("page_token", pageToken);
    const data = await feishu(`/bitable/v1/apps/${appToken}/tables/${tableId}/records?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    items.push(...(data.data.items || []));
    pageToken = data.data.page_token || "";
    if (!data.data.has_more) break;
  } while (pageToken);
  return items;
}

async function listFields(tableId) {
  const token = await getTenantToken();
  const appToken = await getAppToken();
  const items = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (pageToken) qs.set("page_token", pageToken);
    const data = await feishu(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    items.push(...(data.data.items || []));
    pageToken = data.data.page_token || "";
    if (!data.data.has_more) break;
  } while (pageToken);
  return items;
}

async function ensureTextField(tableId, fieldName) {
  const fields = await listFields(tableId);
  if (fields.some((field) => field.field_name === fieldName)) return;
  const token = await getTenantToken();
  const appToken = await getAppToken();
  await feishu(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ field_name: fieldName, type: 1 })
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("body_too_large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("upload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

async function readMultipartFiles(req) {
  const contentType = req.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("missing_upload_boundary");
  const body = await readRawBody(req);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  return splitBuffer(body, boundaryBuffer)
    .map((part) => {
      let clean = part;
      if (clean.subarray(0, 2).toString() === "\r\n") clean = clean.subarray(2);
      if (clean.subarray(0, 2).toString() === "--") return null;
      const headerEnd = clean.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd === -1) return null;
      const headerText = clean.subarray(0, headerEnd).toString("utf8");
      let data = clean.subarray(headerEnd + 4);
      if (data.subarray(data.length - 2).toString() === "\r\n") data = data.subarray(0, data.length - 2);
      const disposition = headerText.match(/content-disposition:\s*([^\r\n]+)/i)?.[1] || "";
      const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
      const name = disposition.match(/name="([^"]*)"/i)?.[1] || "";
      if (!filename || !data.length) return null;
      const contentType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
      return { field: name, filename: path.basename(filename), contentType, data };
    })
    .filter(Boolean);
}

async function uploadFileToOss(file) {
  if (!OSS_CONFIG.token) throw new Error("oss_not_configured");
  const formData = new FormData();
  formData.append("file", new Blob([file.data], { type: file.contentType }), file.filename);
  formData.append("subDir", OSS_CONFIG.subDir);
  const response = await fetch(OSS_CONFIG.uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${OSS_CONFIG.token}` },
    body: formData
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.data?.isSuccess || !result?.data?.fullUrl) {
    throw new Error(result?.msg || result?.message || `oss_upload_failed_${response.status}`);
  }
  return {
    name: file.filename,
    size: file.data.length,
    url: result.data.fullUrl
  };
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function publicUser(record) {
  const fields = record.fields || {};
  return {
    recordId: record.record_id,
    email: fields["邮箱"],
    name: fields["姓名"] || fields["名称"] || fields["邮箱"],
    role: fields["角色"] || "reviewer",
    status: fields["状态"] || "启用"
  };
}

async function findUserByEmail(email) {
  const users = await listUserRecords();
  const normalized = normalizeEmail(email);
  return users.find((record) => normalizeEmail(record.fields?.["邮箱"]) === normalized) || null;
}

async function listUserRecords() {
  const now = Date.now();
  if (userRecordsCache && userRecordsCache.expiresAt > now) {
    return userRecordsCache.records;
  }
  const records = await listRecords(CONFIG.userTableId);
  userRecordsCache = {
    records,
    expiresAt: now + 60 * 1000
  };
  return records;
}

function invalidateUserRecordsCache() {
  userRecordsCache = null;
}

function loadSkills() {
  if (skillsCache) return skillsCache;
  const skillsPath = path.join(ROOT, "skills.json");
  if (!fs.existsSync(skillsPath)) return [];
  try {
    skillsCache = JSON.parse(fs.readFileSync(skillsPath, "utf8")).skills || [];
  } catch {
    skillsCache = [];
  }
  return skillsCache;
}

function readTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
  } catch { return []; }
}

function writeTasks(tasks) {
  const tmp = TASKS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
  fs.renameSync(tmp, TASKS_FILE);
}

function upsertTask(task) {
  const tasks = readTasks();
  const index = tasks.findIndex((t) => t.localId === task.localId);
  if (index >= 0) {
    tasks[index] = { ...tasks[index], ...task, updatedAt: Date.now() };
  } else {
    tasks.push({ ...task, createdAt: Date.now(), updatedAt: Date.now() });
  }
  writeTasks(tasks);
  return task;
}

function loadBatches() {
  try {
    if (!fs.existsSync(BATCHES_FILE)) return [];
    return JSON.parse(fs.readFileSync(BATCHES_FILE, "utf8"));
  } catch { return []; }
}

function saveBatches(batches) {
  const tmp = BATCHES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(batches, null, 2), "utf8");
  fs.renameSync(tmp, BATCHES_FILE);
}

async function createUser({ email, password, name, role = "reviewer" }) {
  const normalized = normalizeEmail(email);
  const displayName = String(name || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("请输入有效邮箱");
  if (!displayName) throw new Error("请输入姓名");
  if (String(password || "").length < 8) throw new Error("密码至少 8 位");
  const existing = await findUserByEmail(normalized);
  if (existing) throw new Error("该邮箱已注册");
  await ensureTextField(CONFIG.userTableId, "姓名");
  const token = await getTenantToken();
  const appToken = await getAppToken();
  const salt = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const fields = {
    "邮箱": normalized,
    "姓名": displayName,
    "密码哈希": passwordHash(password, salt),
    "盐": salt,
    "角色": role,
    "状态": "启用",
    "创建时间": now,
    "更新时间": now
  };
  const data = await feishu(`/bitable/v1/apps/${appToken}/tables/${CONFIG.userTableId}/records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields })
  });
  invalidateUserRecordsCache();
  return publicUser(data.data.record);
}

async function loginUser({ email, password }) {
  const user = await findUserByEmail(email);
  if (!user) throw new Error("邮箱或密码不正确");
  const fields = user.fields || {};
  if (fields["状态"] && fields["状态"] !== "启用") throw new Error("账号已停用");
  const expected = fields["密码哈希"];
  const salt = fields["盐"];
  const actual = passwordHash(String(password || ""), salt || "");
  const ok = expected && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!ok) throw new Error("邮箱或密码不正确");
  touchLastLogin(user.record_id).catch(() => {});
  return publicUser(user);
}

async function touchLastLogin(recordId) {
  const token = await getTenantToken();
  const appToken = await getAppToken();
  await feishu(`/bitable/v1/apps/${appToken}/tables/${CONFIG.userTableId}/records/${recordId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { "最后登录": Date.now(), "更新时间": Date.now() } })
  });
}

function createSession(user) {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ user, expiresAt }), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", CONFIG.appSecret || "creative-hub-local")
    .update(payload)
    .digest("base64url");
  const token = `${payload}.${signature}`;
  sessions.set(token, { user, expiresAt });
  return token;
}

function getAuth(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (session && session.expiresAt >= Date.now()) {
    return session.user;
  }
  if (session) sessions.delete(token);

  const verified = verifySessionToken(token);
  if (verified) {
    sessions.set(token, verified);
    return verified.user;
  }
  if (token) sessions.delete(token);
  return null;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto
    .createHmac("sha256", CONFIG.appSecret || "creative-hub-local")
    .update(payload)
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.user || !data.expiresAt || data.expiresAt < Date.now()) {
      return null;
    }
    return { user: data.user, expiresAt: data.expiresAt };
  } catch {
    if (token) sessions.delete(token);
    return null;
  }
}

function requireAuth(req) {
  const user = getAuth(req);
  if (!user) throw new Error("unauthorized");
  return user;
}

function linkValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.link || value.text || "";
}

function normalizeProduct(record) {
  const fields = record.fields || {};
  const detailImages = parseJsonField(fields["商品详情图URLs"], []);
  const features = parseJsonField(fields["商品卖点"], []);
  const specs = parseJsonField(fields["商品规格"], {});
  return {
    id: fields["商品ID"] || record.record_id,
    recordId: record.record_id,
    name: fields["商品名称"] || "未命名商品",
    sku: fields["SKU"] || "",
    category: fields["类目"] || "",
    owner: fields["品牌"] || "",
    description: fields["商品描述"] || "",
    cover: linkValue(fields["封面素材URL"]),
    detailImages: Array.isArray(detailImages) ? detailImages : [],
    features: Array.isArray(features) ? features : [],
    specs: specs && typeof specs === "object" && !Array.isArray(specs) ? specs : {},
    price: fields["参考价格"] || "",
    sourceUrl: fields["商品来源URL"] || "",
    status: fields["状态"] || "启用"
  };
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function relationRecordId(value) {
  const first = Array.isArray(value) ? value[0] : null;
  if (!first) return "";
  if (typeof first === "string") return first;
  return Array.isArray(first.record_ids) ? first.record_ids[0] : "";
}

function normalizeAsset(record, productByRecordId) {
  const fields = record.fields || {};
  const productRecordId = relationRecordId(fields["关联商品"]);
  const product = productByRecordId.get(productRecordId);
  const file = fields["文件名"] || `${fields["素材ID"] || record.record_id}.mp4`;
  const url = linkValue(fields["视频URL"]) || file;
  const derived = deriveVersion(file);
  const version = fields["版本"] || derived.version;
  const assetId = normalizeAssetId(fields["素材ID"]) || derived.assetId;
  return {
    file,
    assetId,
    version,
    versionNumber: versionNumber(version),
    recordId: record.record_id,
    title: fields["素材名称"] || file,
    scene: fields["场景"] || "",
    size: parseSize(fields["文件大小"]),
    url,
    mediaType: mediaTypeFor(url || file),
    createdAt: fields["创建时间"] || "",
    updatedAt: fields["更新时间"] || "",
    reviewer: fields["审核人"] || "",
    reviewedAt: fields["审核时间"] || "",
    review: {
      recordId: record.record_id,
      assetId,
      version,
      productId: product?.id || "",
      productRecordId,
      status: statusToCode(fields["审核状态"]),
      published: Boolean(fields["发布状态"]),
      tags: Array.isArray(fields["素材标签"]) ? fields["素材标签"] : [],
      comment: fields["修改意见"] || "",
      createdAt: fields["创建时间"] || "",
      updatedAt: fields["更新时间"] || "",
      reviewer: fields["审核人"] || "",
      reviewedAt: fields["审核时间"] || ""
    }
  };
}

function normalizeAssetId(value) {
  const id = String(value || "").trim();
  return id ? id : "";
}

function deriveVersion(file) {
  const name = path.basename(file, path.extname(file));
  const match = name.match(/^(.*)_V(\d+)$/);
  if (match) {
    return { assetId: match[1], version: `V${match[2]}` };
  }
  return { assetId: name, version: "V1" };
}

function versionNumber(version) {
  const match = String(version || "V1").match(/\d+/);
  return match ? Number(match[0]) : 1;
}

function parseSize(value) {
  if (typeof value !== "string") return 0;
  const match = value.match(/([\d.]+)/);
  if (!match) return 0;
  const number = Number(match[1]);
  return /kb/i.test(value) ? Math.round(number * 1024) : Math.round(number * 1024 * 1024);
}

function formatSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return "";
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function mediaTypeFor(file) {
  const clean = String(file || "").split(/[?#]/)[0].toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif|avif|heic)$/.test(clean)) return "image";
  return "video";
}

function statusToCode(value) {
  return {
    "待审核": "pending",
    "审核通过": "approved",
    "建议修改": "revision"
  }[value] || "pending";
}

function codeToStatus(value) {
  return {
    pending: "待审核",
    approved: "审核通过",
    revision: "建议修改"
  }[value] || "待审核";
}

function fileUrl(file) {
  if (/^https?:\/\//.test(file) || file.startsWith("file:///")) return file;
  return `/${encodeURIComponent(file)}`;
}

function isLocalRequest(req) {
  if (process.env.VERCEL) return false;
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(":")[0].toLowerCase();
  return ["localhost", "127.0.0.1", "::1"].includes(host) && (!forwardedHost || ["localhost", "127.0.0.1", "::1"].includes(forwardedHost));
}

function cleanBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function modelSquare(pathname, options = {}) {
  if (!MODEL_CONFIG.appSecret) throw new Error("model_square_not_configured");
  const response = await fetch(`${cleanBaseUrl(MODEL_CONFIG.baseUrl)}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-App-Secret": MODEL_CONFIG.appSecret,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(data.msg || data.message || `model_square_failed_${response.status}`);
  }
  return data;
}

async function pixverse(pathname, options = {}) {
  if (!MODEL_CONFIG.pixverseApiKey) throw new Error("pixverse_not_configured");
  const response = await fetch(`${cleanBaseUrl(MODEL_CONFIG.pixverseBaseUrl)}${pathname}`, {
    ...options,
    headers: {
      "API-KEY": MODEL_CONFIG.pixverseApiKey,
      "Ai-trace-id": crypto.randomUUID(),
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ErrCode) {
    throw new Error(data.ErrMsg || data.message || `pixverse_failed_${response.status}`);
  }
  return data;
}

function isPixVerseModel(modelId) {
  return /^PixVerse/i.test(String(modelId || ""));
}

function pixverseModelName(modelId) {
  const value = String(modelId || "");
  if (/v6/i.test(value)) return "v6";
  if (/v4\.5/i.test(value)) return "v4.5";
  if (/v4/i.test(value)) return "v4";
  return "v6";
}

function normalizePixVerseStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (status === "1" || status === "success" || status === "completed") return "completed";
  if (status === "5" || status === "pending" || status === "processing" || status === "running") return "processing";
  if (status === "7" || status === "8" || status === "failed" || status === "error") return "failed";
  return "processing";
}

async function uploadPixVerseImage(imageUrl) {
  const form = new FormData();
  form.append("image_url", imageUrl);
  const data = await pixverse("/openapi/v2/image/upload", {
    method: "POST",
    body: form
  });
  const imgId = data.Resp?.img_id || data.Resp?.imgId || data.data?.img_id || "";
  if (!imgId) throw new Error("pixverse_image_upload_no_img_id");
  return imgId;
}

function buildPixVerseVideoBody(job) {
  const body = {
    model: pixverseModelName(job.meta.model),
    prompt: String(job.pixverse.prompt || "").slice(0, 2048),
    aspect_ratio: job.pixverse.ratio,
    duration: job.pixverse.duration,
    quality: job.pixverse.quality,
    motion_mode: "normal"
  };
  return body;
}

function normalizePixVerseTask(response, meta = {}) {
  const data = response?.Resp || response?.data || response || {};
  const videoId = data.video_id || data.videoId || data.id || meta.taskId || "";
  const status = normalizePixVerseStatus(data.status || data.state || meta.status);
  const urls = [...new Set(collectUrls(data))];
  return {
    ...meta,
    taskId: videoId ? `pixverse:${videoId}` : "",
    providerTaskId: videoId,
    status,
    urls,
    url: urls[0] || "",
    message: data.message || data.ErrMsg || ""
  };
}

async function createPixVerseVideoTask(job) {
  const body = buildPixVerseVideoBody(job);
  let endpoint = "/openapi/v2/video/text/generate";
  if (job.pixverse.referenceImages.length) {
    body.img_id = await uploadPixVerseImage(job.pixverse.referenceImages[0]);
    endpoint = "/openapi/v2/video/img/generate";
  }
  const response = await pixverse(endpoint, {
    method: "POST",
    body: JSON.stringify(body)
  });
  const task = normalizePixVerseTask(response, job.meta);
  task.requestBody = body;
  return task;
}

async function getPixVerseTask(taskId) {
  const providerTaskId = String(taskId || "").replace(/^pixverse:/, "");
  const response = await pixverse(`/openapi/v2/video/result/${encodeURIComponent(providerTaskId)}`, {
    method: "GET"
  });
  return normalizePixVerseTask(response, { taskId: `pixverse:${providerTaskId}`, providerTaskId });
}

function collectUrls(value, urls = []) {
  if (!value) return urls;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) urls.push(value);
    return urls;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, urls));
    return urls;
  }
  if (typeof value === "object") {
    ["url", "videoUrl", "video_url", "fullUrl", "resultUrl", "outputUrl", "coverUrl"].forEach((key) => collectUrls(value[key], urls));
    ["urls", "videos", "videoUrls", "video_urls", "result", "results", "output", "outputs", "files"].forEach((key) => collectUrls(value[key], urls));
  }
  return urls;
}

function normalizeReferenceImages(value) {
  const urls = [...new Set(collectUrls(value))]
    .filter((url) => /\.(jpg|jpeg|png|webp|gif|avif|heic)(\?|#|$)/i.test(url) || /image|img|photo|product/i.test(url));
  return urls.slice(0, 6);
}

function normalizeVideoTask(response, meta = {}) {
  const data = response?.data || response || {};
  const status = String(data.status || data.taskStatus || data.state || meta.status || "pending").toLowerCase();
  const urls = [...new Set(collectUrls(data))];
  return {
    ...meta,
    taskId: data.taskId || data.task_id || data.id || meta.taskId || "",
    status,
    urls,
    url: urls[0] || "",
    message: data.message || data.msg || data.error || ""
  };
}

function fallbackScriptsForSkill(payload, skill, count) {
  const product = payload.product || {};
  const brief = String(payload.brief || "").trim();
  const productName = product.name || "product";
  const productSku = product.sku || "";

  const templates = {
    "product-hero": [
      {
        title: "产品英雄镜头",
        script: `15秒竖屏产品英雄展示。0-4s：极简背景，产品居中，Dolly In慢推，三点布光勾勒轮廓。4-8s：微距滑轨展示材质细节，rack focus焦点在产品logo和纹理间切换。8-15s：360度缓旋，慢动作收尾，产品定格于画面中央。${brief}`,
        prompt: `[0-4s] Subject: ${productName} ${productSku}, centered in frame against clean minimal background. Camera & Movement: Low-angle dolly in, starting from waist level, smooth slow push-in at 0.3m/s. Lighting: Three-point cinematic lighting, key light at 45 degrees left, rim light separating product edge from background, soft fill at 30%. Composition: Symmetrical center framing, f/2.8 shallow depth of field, product occupies 60% of frame. Action: Product slowly rotating 15 degrees, revealing contour and silhouette.\n[4-8s] Subject: ${productName} macro detail — material texture, logo engraving, stitching precision. Camera & Movement: Macro slider tracking shot, 5cm/sec lateral slide, rack focus pulling from logo to material surface over 1.5s. Lighting: Soft diffused key light at 60 degrees, creating subtle shadow depth in material grain. Composition: Extreme close-up, f/1.8, focus breathing between 3cm-8cm range.\n[8-15s] Subject: ${productName} full 360-degree hero reveal. Camera & Movement: 360-degree orbital rotation at 6 degrees/sec, slowing to freeze frame at final second. Lighting: Key light strengthening to 80% intensity, rim light creating golden edge glow. Transition: Smooth dissolve from macro to full product.\nStyle: Cinematic commercial grade, desaturated neutrals, product colors preserved at full saturation, 35mm digital equivalent. BGM: Minimal ambient electronic, 70 BPM, swelling strings at hero reveal moment. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      },
      {
        title: "光影雕塑",
        script: `15秒竖屏光影雕塑展示。0-3s：暗场中一束硬光切入，产品从阴影中浮现。3-8s：光线在产品表面游走，逐区域揭示设计细节。8-12s：多角度快速切换，每个角度不同光位。12-15s：所有灯光汇聚，产品全亮定格。${brief}`,
        prompt: `[0-3s] Subject: ${productName} emerging from complete darkness. Camera & Movement: Static locked-off shot, no movement. Lighting: Single hard spotlight beam cutting diagonally from top-right, creating dramatic chiaroscuro, 80% of frame in deep shadow. Action: Light beam slowly widens from 5-degree to 25-degree cone, product gradually revealed.\n[3-8s] Subject: ${productName} design details illuminated sequentially — silhouette first, then surface texture, then logo/branding, then functional elements. Camera & Movement: Static, macro lens at 100mm equivalent. Lighting: Moving light — a narrower beam (8-degree) travelling across product surface at 2cm/sec, like a scanner revealing each detail. Shadow edges crisp and deliberate.\n[8-12s] Subject: ${productName} from 4 distinct angles — front, 45-degree, side, top-down. Camera & Movement: Hard cuts between angles, each cut synced to light change. Lighting: Different lighting setup per angle — Rembrandt, split, butterfly, rim-only — each held for 1s.\n[12-15s] Subject: ${productName} in full illumination, all details visible. Camera & Movement: Slow 5-degree push-in to final hero frame. Lighting: All three-point lights converging to full brightness, final frame at commercial beauty standard. Style: High-contrast luxury, deep blacks at IRE 5, highlights at IRE 95, no lifted shadows. BGM: Deep bass swell, cinematic tension-and-release, 60 BPM. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "street-lifestyle": [
      {
        title: "城市日常",
        script: `15秒竖屏街头生活方式。0-3s：街角场景，人物自然站立，手持跟拍轻微呼吸感。3-7s：人物开始行走，镜头侧跟，产品融入日常。7-12s：穿过不同城市场景，快节奏切换。12-15s：人物回眸，产品自然展现，定格收尾。${brief}`,
        prompt: `[0-3s] Character: A 22-year-old student with relaxed confidence, short dark hair, wearing ${productName} with casual outfit — oversized hoodie, loose-fit jeans. Scene: City street corner at 4pm, autumn golden hour, warm amber light filtering through buildings, scattered leaves on pavement. Camera & Movement: Handheld at chest height (140cm), natural micro-shake breathing rhythm, documentary-style observational framing. Lighting: Natural backlight from setting sun, soft golden rim on subject's shoulders, ambient bounce from concrete buildings filling shadows at 40%.\n[3-7s] Character: Same person, now walking naturally along pedestrian crossing, earbuds in, slight smile. Scene: Crosswalk with city backdrop, light traffic in distant bokeh. Camera & Movement: Side-tracking dolly, matching walking speed at 1.2m/s, gimbal-stabilized with intentional drift. ${productName} visible with each step — product naturally integrated into the walk cycle. Lighting: Cross-light from street side, creating alternating light-shadow pattern as subject walks.\n[7-12s] Quick montage of 3 micro-scenes: (1) sitting on park bench tying laces, (2) stepping off curb, (3) reflection in shop window. Camera: Each scene held 1.5s, handheld snap-zoom transitions between scenes. Scene variety showing urban life — park greenery, concrete curb, glass reflection.\n[12-15s] Character turns back to glance at camera, natural half-smile, ${productName} prominently framed in foreground. Freeze frame on final beat. Transition: Whip pan between walking and montage; hard cut to final glance.\nStyle: Warm natural color palette, slight film grain (35mm Portra 400 reference), lifted blacks to IRE 8, golden undertone. BGM: Lo-fi hiphop beat, 85 BPM, relaxed drum pattern with vinyl crackle. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      },
      {
        title: "天台黄昏",
        script: `15秒竖屏天台场景。0-3s：天台边缘，城市天际线背景，人物倚靠栏杆。3-7s：镜头环绕人物，展示全身搭配。7-12s：坐下系鞋带特写，夕阳逆光。12-15s：起身走向镜头，低角度仰拍收尾。${brief}`,
        prompt: `[0-3s] Character: 24-year-old creative, slightly disheveled hair, wearing ${productName} with wide-leg trousers and a vintage band tee. Scene: Rooftop at dusk, city skyline silhouette against orange-purple gradient sky, warm wind轻微 blowing fabric, distant city lights beginning to flicker on. Camera: Handheld at eye level, slow creep-in, breathing micro-movements.\n[3-7s] Camera orbits subject in 180-degree semi-circle at 1.5m radius, gimbal-stabilized, maintaining subject centered. ${productName} visible throughout orbit — side profile, back detail, other side. Lighting: Golden hour rim light wrapping subject, skin tones warm at 3200K, sky at 5600K creating natural color contrast.\n[7-12s] Subject sits on rooftop edge, camera drops to ground level (25cm). Extreme low angle looking up at ${productName} as subject ties laces. Backlit by setting sun creating halo around product silhouette. Slow-motion at 60fps for dreamlike quality.\n[12-15s] Subject stands and walks toward camera. Camera pulls back maintaining distance, then settles into low-angle hero shot. Final frame: ${productName} in sharp focus, subject's face soft-focused, city lights bokeh background.\nStyle: Cinematic golden hour, warm橙色 and teal blue color contrast, Kodak Vision3 250D film emulation, halation on highlights at 12%. BGM: Dreamy lo-fi beat, 78 BPM, reverb-drenched guitar sample. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "asmr-sensory": [
      {
        title: "材质交响",
        script: `15秒竖屏ASMR感官体验。0-5s：极近微距，镜头缓慢靠近产品表面，展现第一层材质纹理。5-10s：焦点游走于不同材质区域之间，每一次焦点转移揭示新的触感细节。10-15s：镜头缓慢拉远，产品全貌在柔光中完整呈现。${brief}`,
        prompt: `[0-5s] Subject: ${productName} surface texture at 3:1 macro magnification — every pore, weave, grain, or polish mark visible. Camera & Movement: Extreme macro lens (100mm f/2.8), starting at 5cm focus distance, creeping forward at 1mm/sec. Depth of field razor-thin at 0.3mm. Lighting: Ultra-soft diffused light from 180-degree wrap-around softbox, no hard shadows, light ratio 1:1.2. The slow movement creates a tactile sensation — the viewer should almost feel the texture through their eyes.\n[5-10s] Rack focus journey across ${productName} surface: (1) Starting on grain/leather pore at 3cm, hold 2s. (2) Shifting to stitching/seam detail at 4cm over 1.5s focus pull. (3) Landing on logo/branding engraving at 3.5cm. Each focus destination reveals a different material story. Lighting: Subtle angle change on key light (5-degree shift) with each focus move, creating micro-shadow variations that emphasize texture depth.\n[10-15s] Camera slowly pulls back from macro to product-scale view over 5 seconds. ${productName} gradually revealed in full. Final 2 seconds: product静止 in warm soft light, all textures now contextualized in the whole.\nStyle: Warm neutral palette (cream, beige, soft brown), near-zero saturation in backgrounds, product material colors subtly preserved. 35mm film emulation with fine grain for tactile warmth. BGM: None — or extremely minimal ambient pad at -24dB. Sound design focus: imagine the sound of the material — fabric whisper, leather creak, metal shimmer. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "tech-review": [
      {
        title: "功能解析",
        script: `15秒竖屏科技测评。0-4s：白色studio背景，产品居中，环形布光，专业展示。4-9s：手部入画进行功能演示，镜头跟随手指动作。9-13s：多角度功能展示，快速切换。13-15s：产品回归中央，专业收尾。${brief}`,
        prompt: `[0-4s] Subject: ${productName} ${productSku}, centered on matte white infinity surface. Camera & Movement: Static locked-off at product eye-level, 50mm equivalent lens. Composition: Product occupies 50% of frame, generous negative space. Lighting: Ring light at 80% intensity, 5600K daylight balanced, eliminating all shadows on product face. Secondary softbox from above at 40% for gentle top-down definition.\n[4-9s] Action: Hands enter frame from bottom — clean, neutral nails, no distracting jewelry. Hands demonstrate ${productName} key function: pressing a button, rotating a dial, opening a compartment. Camera tracks hand movement with subtle gimbal tilt (5-degree range). Lighting maintains even illumination throughout hand interaction.\n[9-13s] Rapid demonstration cuts: (1) Close-up of functional detail at 2:1 macro, (2) Wide shot showing full product in use context, (3) Detail of result/effect. Each held 1.3s, hard cuts synced to BPM.\n[13-15s] ${productName} returns to center frame. Subtle 3-degree push-in. Final composition: product sharp, white背景 pure, professional and trustworthy.\nStyle: Cool neutral palette (white, light grey, subtle blue undertone at 7200K). High clarity, zero film grain — digital perfection aesthetic. BGM: Clean electronic beat, 95 BPM, minimal arrangement — kick, snare, subtle arpeggio. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "emotional-narrative": [
      {
        title: "微光时刻",
        script: `15秒竖屏情绪叙事。0-4s：人物独处场景，浅景深，氛围光，情绪铺垫。4-9s：情绪转折点，${productName || "产品"}自然进入画面。9-13s：情绪升华，光影变化呼应内心。13-15s：收束于安静定格。${brief}`,
        prompt: `[0-4s] Character: A 26-year-old person sitting alone by a rain-streaked window, soft grey sweater, lost in thought. Their posture slightly hunched, gaze distant. Scene: Small cafe corner, 5pm winter, blue-grey ambient light through wet glass, steam rising from a cup on the table. Camera: Static at 1.5m distance, 85mm lens, f/1.4 — subject sharp, window light bokeh circles floating behind. No movement. Lighting: Single practical light source (window), cool 6000K ambient, skin tones slightly desaturated.\n[4-9s] Emotional turn: A notification lights up their phone screen. They glance down. ${productName} is beside the phone — not the focus, but present in the moment of connection. Camera: Slow creep-in from 1.5m to 1.2m over 5 seconds, barely perceptible. Focus stays on the character's expression as it softens from melancholy to a hint of warmth.\n[9-13s] They pick up ${productName} absentmindedly, fingers tracing its edge. The gesture is unconscious, comforting. Camera: Rack focus subtly shifts from face to product and back over 2s. Lighting: The grey窗外 light begins to warm slightly — as if clouds are thinning — 6000K drifting to 4800K. A subtle golden glow emerging.\n[13-15s] Character sets ${productName} down gently, takes a breath, slight smile. Camera settles, focus lands on product in foreground (sharp), character soft-focused behind. Hold 2 seconds.\nStyle: Moody cinematic, blue-grey dominant with emerging warmth, lifted blacks at IRE 10, soft highlight roll-off. 35mm anamorphic character — subtle horizontal flare, oval bokeh. BGM: Solo piano, sparse and melancholic, resolving to a gentle major chord at the emotional turn at 9s. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "flash-sale": [
      {
        title: "限时冲击",
        script: `15秒竖屏快节奏闪购。0-2s：高能开场，产品从画面中心爆发。2-5s：快速跳切3个角度，每个0.5-1s。5-10s：动态粒子+速度线+产品旋转冲击。10-15s：倒计时紧迫感，产品定格+闪光收尾。${brief}`,
        prompt: `[0-2s] Subject: ${productName} exploding into frame center from a burst of white light. Camera: Crash zoom from 200mm to 35mm in 0.5s, creating extreme motion blur and impact. Background: Pure black with expanding shock wave ring. Lighting: Intense flash at frame center, 100% brightness for 3 frames then decay to 70%.\n[2-5s] Rapid-fire product angles — 3 shots at 0.8s each: (1) Front hero at 30-degree tilt, (2) Detail close-up with speed lines radiating outward, (3) Dynamic Dutch angle at 15 degrees. Camera: Hard cuts with 2-frame white flash between each. ${productName} color saturation pushed to 130%.\n[5-10s] ${productName} rotating 90 degrees at high speed with particle trail — gold and white particles exploding from edges. Speed lines racing across frame. Multiple ${productName} copies ghosting in trail. Camera: Orbiting at 90 degrees/sec with motion blur. Lighting: Strobing between warm gold and cool white at 8Hz.\n[10-15s] Urgency build: frame暗角 tightening, red glow pulsing at edges. ${productName} slams to center stop. Final 1.5s: ${productName} in hero pose, particles freeze mid-air, single intense flash, cut to black.\nStyle: High saturation (global +30%), ultra-high contrast, crushed blacks, neon gold accent. Zero film grain — digital sharpness. BGM: Aggressive EDM build-up, 140 BPM, heavy sidechain compression, climax drop at 12s, bass hit at final flash. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "outfit-change": [
      {
        title: "风格切换",
        script: `15秒竖屏穿搭变换。0-3s：第一套搭配亮相，全身镜前，全身展示。3-6s：Match Cut转身切换第二套。6-10s：再切两套搭配，每套不同场景。10-15s：四套并排定格或final walk收尾。${brief}`,
        prompt: `[0-3s] Character: 23-year-old person with versatile style, standing before a full-length mirror in a bright loft apartment. Outfit 1: Casual street — oversized denim jacket, white tee, relaxed-fit chinos, ${productName}. Camera: Full-body shot at 2.5m distance, 35mm lens. Movement: Slow dolly left revealing full outfit. Lighting: Soft morning light from large windows, 5000K, creating ambient fill.\n[3-6s] Match Cut transition: Subject executes a 180-degree spin. At spin midpoint (90 degrees), when body blurs with motion, cut to Outfit 2. Same subject now in: Smart casual — tailored blazer, roll-neck knit, slim trousers, ${productName} (different colorway). Scene shift: Urban cafe terrace, afternoon light. The spin completes seamlessly in new outfit and location.\n[6-10s] Two more rapid switches: (1) Swish pan transition at 6.5s to Outfit 3 — athleisure, joggers, hoodie, ${productName}, park setting. (2) Snap-change at 8.5s to Outfit 4 — evening wear, leather jacket, dark denim, ${productName}, neon-lit street. Each transition under 0.5s.\n[10-15s] All four outfits shown as a 4-way split screen for 2s, then dissolve to subject walking toward camera in Outfit 1 (bookend). Final frame: ${productName} prominent, confident stride.\nStyle: Bright, clean, editorial fashion lookbook. Slightly desaturated for cohesion, warm undertone throughout. BGM: Upbeat funk-pop, 110 BPM, driving bassline, snappy snare. Each outfit switch synced to snare hit. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "visual-experiment": [
      {
        title: "解构重生",
        script: `15秒竖屏视觉实验。0-4s：产品在纯白空间中缓慢解体，部件悬浮。4-9s：每个部件被赋予独立运动轨迹，粒子化边缘。9-13s：部件重新组合，形态变异。13-15s：汇聚为新的视觉形态定格。${brief}`,
        prompt: `[0-4s] Subject: ${productName} floating in infinite white void (no horizon, no shadow ground). Product slowly deconstructs — each component separating along its natural seam lines at 2mm/sec. Camera: Static wide shot at 2m. Lighting: Ambient occlusion only, no directional light source, product self-illuminated at 60%.\n[4-9s] Each ${productName} component now orbits independently — some rotating on axis, some tracing circular paths, some drifting upward. Particle trails streaming from edges — silver and white micro-particles with 2-second decay. Camera: Slow orbital rotation at 3 degrees/sec, maintaining all components in frame. Lighting: Each component now emitting its own subtle colored glow — product brand colors at 30% opacity.\n[9-13s] Components begin reassembly but in a new configuration — an impossible geometry, Escher-like, product recognizable but spatially impossible. Camera: Push-in from 2m to 0.8m, focal length shifting from 35mm to 24mm creating perspective warp. CG quality: Ray-traced reflections on component surfaces, ambient occlusion in crevices.\n[13-15s] All components snap into final form — a geometric sculpture, ${productName} essence preserved but abstracted. Hold 2 seconds. Final frame: sculpture slowly rotating on Y-axis.\nStyle: CG art film, hyper-clean render, no film grain (digital purity), color palette: white + product accent colors + silver particles. BGM: Experimental electronic, 100 BPM, glitchy percussion, spacious reverb. Ascending synth pad at reassembly moment. Technical: 15s, 9:16 vertical, 24fps, no text overlay, no watermark.`
      }
    ],
    "sd25-pe": [
      {
        title: "结构化生成",
        script: `按Seedance 2.5结构化模板生成。${brief}`,
        prompt: `【生成目标】\n生成一段产品展示视频，核心主体是${productName}${productSku ? " " + productSku : ""}，主要事件是展示产品的外观、质感与使用场景。\n\n【主体与关系】\n${productName}始终保持原有设计、颜色和结构。\n\n【事件脚本】\n开始时：${productName}置于自然场景中，光线柔和。\n主要事件：镜头缓慢推进展示产品细节；人物自然使用产品融入日常场景。\n结束时：产品回归画面中央定格。\n\n【保持一致】\n保持${productName}的颜色、结构、数量稳定。场景空间方向一致。`
      }
    ],
    "nike-cinematic": [
      {
        title: "大学午后·暗调街头",
        script: `15秒竖屏Nike Dunk Panda五段式视频。0-3s开箱：低角度腰平，鞋盒在沥青地面，Dolly In+Rack Focus reveal。3-6s材质：贴地滑轨特写，Crash Zoom鞋带。6-9.5s上脚：过膝低角度，Speed Ramp慢动作。9.5-12.5s行走：贴地POV Handheld Chase。12.5-15s定格：Top-Down到Swoosh特写+Nike logo。${brief}`,
        prompt: `[0-3s] Shot 1: Opening — Unboxing Reveal. Subject: Red Nike shoebox placed diagonally on dark asphalt ground, box lid at 15-degree angle, Nike logo facing camera. Scene: University campus, afternoon 3pm, tree shadow dappled on asphalt, bicycle shed立柱 in bokeh background (cool green tone). Camera: Low-angle waist-level (33cm from ground), static hold 0.8 seconds first-frame anchor, then Dolly In smooth push toward box over 1.2s. Action: Sun-tanned hand with ink marks on knuckles enters frame, lifts box lid. Rack Focus: focus snaps from box surface logo to shoe inside over 0.3s — shoe revealed from blur to sharp in斑驳 tree light. Transition: Whip Pan right with motion blur, synced to BGM downbeat.\n[3-6s] Shot 2: Material Study. Subject: Nike Dunk Low Panda — black leather Swoosh arc, white leather toe cap, black lace eyelets, texture pores visible. Camera: Ground-level tracking slide (gimbal float), moving heel-to-toe at 3cm/sec, f/1.8 shallow depth of field. Lighting: Side-backlight 45 degrees, white toe cap at Zone VII (warm, not blown), black leather at Zone III (textured, not crushed). Crash Zoom into lace area at 5s mark. Action: Fingers with thin calluses pull black lace gently, camera micro-dolly follows. Transition: Match Cut — black circular eyelet matches to circular shadow fold on grey sweatpants knee in next shot.\n[6-9.5s] Shot 3: On-Foot. Character: 20-year-old university student, short neutral hair, black backpack, white wireless earbuds. Sitting on library concrete steps. Outfit: Loose cream-white shirt (sleeves rolled to forearm), dark grey straight-leg sweatpants (cuff naturally stacking on shoe), white mid-calf socks. ${productName}: Nike Dunk Low Panda. Action: Toe taps asphalt twice. On second tap: Speed Ramp — 24fps to 96fps slow-motion for 0.6s, then hard cut back to 24fps. During slow-mo: subtle Punch-In (110% scale) emphasizing sole-to-ground contact. Camera: Over-knee low angle, Dutch Angle 3 degrees for street tension. Steadicam Float orbits 15 degrees right. Lighting: Afternoon cross-light 45 degrees, white shoe face in soft highlight, library glass reflecting tree dapples as practical flare. Transition: Action Whip — toe kicks small pebble toward bicycle tire, camera follows pebble trajectory in whip motion, extreme motion blur cuts to next shot.\n[9.5-12.5s] Shot 4: Walking Chase. Character walks across campus asphalt path. Camera: Ground-level POV tracking (15cm from ground), Handheld Chase with natural x/y-axis micro-shake and breathing rhythm. Each footstep: Camera Shake on 808 kick (downward micro-jolt) and snare (subtle Punch-In 102-105% snap-back). Cutting rhythm: every 0.8s a cut, alternating between sole star-pattern grip detail and side Swoosh profile against sweatpant sway. Lighting: Overhead sun through leaves, dappled light spots sweeping across shoe surface, grey asphalt creating diffuse fill from below. Transition: Smash Cut at most dynamic stride moment — 3 frames pure white flash before hard cut to stillness.\n[12.5-15s] Shot 5: Hero Freeze. ${productName} placed back on red Nike shoebox, dark asphalt and bicycle shed立柱 background. Opening: Top-Down 90-degree俯视, static 0.5s. Then Crane-Down-to-Dolly: camera arm descends while pushing toward side Swoosh in arcing trajectory. Final 1 second: low-angle side view, Swoosh占据 visual center, red shoebox as color base below. Nike logo subtitle fades in — white bold sans-serif, top quarter of frame (only text in entire video). Ending: 0.5s Hold Frame freeze on Swoosh close-up. Final 1 frame: brightness normalized for seamless TikTok loop back to Shot 1.\nStyle: Desaturated Cool Green & Warm Neutral. Shadows shift cool green (#1a2e25), highlights neutral warm white, midtones grey-brown. Global saturation -20%, contrast +25%. 35mm Kodak Vision3 250D film grain (medium size, density dynamic per segment). Halation 15% on highlight edges. Chromatic aberration 3% only at high-contrast edges. Vignette: 12% Shot 1, 18% Shot 2, 20% Shot 3, 25% Shot 4, hold 25% Shot 5 (NO vignette increase in Shot 5 per iron rule). BGM: Hiphop streetwear / boom bap, BPM 85-95, crisp kick and snare, 808 bass下沉, cool youthful street attitude. Sound design: shoebox paper friction at 1.5s, leather creak at 4s, rubber sole touch at 6.5s, lace fabric pull at 5s, bicycle chain转动 at transition points, distant school bell and campus chatter ambiance. Technical: 15s, 9:16 vertical, 24fps. Nike logo text only at end frame (top quarter). No other text. No watermark.`
      }
    ]
  };

  const skillTemplates = templates[skill.id] || templates["product-hero"];
  const countPerSkill = Math.max(1, Math.min(4, Number(count || 2)));

  return Array.from({ length: countPerSkill }, (_, index) => {
    const tpl = skillTemplates[index % skillTemplates.length];
    return {
      title: `${productName} · ${skill.name} · ${tpl.title}`,
      script: tpl.script,
      prompt: tpl.prompt,
      duration: 15,
      tags: skill.tags || []
    };
  });
}

async function callDeepSeekForSkill(skill, payload, count) {
  const product = payload.product || {};
  const brief = String(payload.brief || "").trim();
  const response = await fetch(`${cleanBaseUrl(MODEL_CONFIG.deepseekBaseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${MODEL_CONFIG.deepseekApiKey}`
    },
    body: JSON.stringify({
      model: MODEL_CONFIG.deepseekModel,
      temperature: 0.8,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: skill.systemPrompt.replace(/\{count\}/g, String(count)) },
        { role: "user", content: JSON.stringify({ product, brief, count }) }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `deepseek_failed_${response.status}`);
  const content = data.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    try {
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = {};
    }
  }
  const scripts = (Array.isArray(parsed.scripts) ? parsed.scripts : []).slice(0, count);
  if (!scripts.length) throw new Error("empty_response");
  return scripts;
}

async function generateProductionScripts(payload) {
  const count = Math.max(1, Math.min(4, Number(payload.countPerSkill || payload.count || 2)));
  const brief = String(payload.brief || "").trim();

  const skillIds = Array.isArray(payload.skillIds) && payload.skillIds.length
    ? payload.skillIds
    : null;

  const allSkills = loadSkills();
  const selectedSkills = skillIds
    ? allSkills.filter((s) => skillIds.includes(s.id))
    : allSkills.filter((s) => s.enabled !== false).slice(0, 3);

  if (!selectedSkills.length) {
    return { provider: "local", groups: [] };
  }

  const hasApiKey = Boolean(MODEL_CONFIG.deepseekApiKey);

  const results = await Promise.allSettled(
    selectedSkills.map(async (skill) => {
      if (!hasApiKey) {
        return { skillId: skill.id, skillName: skill.name, provider: "local", scripts: fallbackScriptsForSkill({ ...payload, brief }, skill, count) };
      }
      try {
        const scripts = await callDeepSeekForSkill(skill, { ...payload, brief }, count);
        return { skillId: skill.id, skillName: skill.name, provider: "deepseek", scripts };
      } catch {
        return { skillId: skill.id, skillName: skill.name, provider: "local", scripts: fallbackScriptsForSkill({ ...payload, brief }, skill, count) };
      }
    })
  );

  const groups = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const skill = selectedSkills[index];
    return { skillId: skill.id, skillName: skill.name, provider: "local", scripts: fallbackScriptsForSkill({ ...payload, brief }, skill, count) };
  });

  const allLocal = groups.every((g) => g.provider === "local");
  return { provider: allLocal ? "local" : "deepseek", groups };
}

const MODEL_SPECS = {
  "Seedance2.5": { resolutions: ["480p","720p"], ratios: ["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"], durationRange: [4,30], defaultResolution: "720p", defaultDuration: 15 },
  "Seedance2.0": { resolutions: ["480p","720p","1080p","4k"], ratios: ["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"], durationRange: [4,15], defaultResolution: "720p", defaultDuration: 15 },
  "Seedance2.0-lite": { resolutions: ["480p","720p","1080p","4k"], ratios: ["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"], durationRange: [4,15], defaultResolution: "720p", defaultDuration: 15 },
  "Seedance2.0-fast": { resolutions: ["480p","720p"], ratios: ["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"], durationRange: [4,15], defaultResolution: "720p", defaultDuration: 15 },
  "Seedance2.0-mini": { resolutions: ["480p","720p"], ratios: ["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"], durationRange: [4,15], defaultResolution: "720p", defaultDuration: 15 },
  "MiniMax-H3": { resolutions: ["768P","2K"], ratios: ["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"], durationRange: [4,15], defaultResolution: "768P", defaultDuration: 15, needsRefRole: true },
  "happyhorse-t2v": { resolutions: ["1080P","720P"], ratios: ["16:9","9:16","1:1","4:3","3:4"], durationRange: [3,15], defaultResolution: "1080P", defaultDuration: 15 },
  "happyhorse-i2v": { resolutions: ["1080P","720P"], ratios: ["16:9","9:16","1:1","4:3","3:4"], durationRange: [3,15], defaultResolution: "1080P", defaultDuration: 15 },
  "veo-3.1": { resolutions: ["720p","1080p","4k"], ratios: ["16:9","9:16"], durationRange: [4,8], defaultResolution: "720p", defaultDuration: 8 },
  "veo-3.1-fast": { resolutions: ["720p","1080p","4k"], ratios: ["16:9","9:16"], durationRange: [4,8], defaultResolution: "720p", defaultDuration: 8 },
  "veo-3.1-lite": { resolutions: ["720p","1080p"], ratios: ["16:9","9:16"], durationRange: [4,8], defaultResolution: "720p", defaultDuration: 8 },
  "kling-3.0": { resolutions: ["720p","1080p","4k"], ratios: ["16:9","9:16","1:1"], durationRange: [3,15], defaultResolution: "720p", defaultDuration: 10 },
  "kling-3.0-omni": { resolutions: ["720p","1080p","4k"], ratios: ["16:9","9:16","1:1"], durationRange: [3,15], defaultResolution: "720p", defaultDuration: 10 },
  "kling-o1": { resolutions: ["720p","1080p"], ratios: ["16:9","9:16","1:1"], durationRange: [3,15], defaultResolution: "720p", defaultDuration: 10 },
  "kling-2.6": { resolutions: ["720p","1080p"], ratios: ["16:9","9:16","1:1"], durationRange: [5,10], defaultResolution: "720p", defaultDuration: 5 },
  "kling-2.5-turbo": { resolutions: ["720p","1080p"], ratios: ["16:9","9:16","1:1"], durationRange: [5,10], defaultResolution: "720p", defaultDuration: 5 },
  "kling-2.1": { resolutions: ["720p","1080p"], ratios: ["16:9","9:16","1:1"], durationRange: [5,10], defaultResolution: "720p", defaultDuration: 5 },
  "PixVerse-V6": { resolutions: ["360p","540p","720p","1080p"], ratios: ["16:9","4:3","1:1","3:4","9:16"], durationRange: [1,15], defaultResolution: "720p", defaultDuration: 5 }
};

function getModelSpec(modelId) {
  return MODEL_SPECS[modelId] || { resolutions: ["720p"], ratios: ["9:16"], durationRange: [4,15], defaultResolution: "720p", defaultDuration: 15 };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function closestAllowedDuration(value, allowed, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return allowed.reduce((best, current) => (
    Math.abs(current - number) < Math.abs(best - number) ? current : best
  ), allowed[0]);
}

function normalizeResolutionForModel(modelId, requestedResolution, spec) {
  const requested = String(requestedResolution || "auto");
  if (requested === "auto") return spec.defaultResolution;
  if (spec.resolutions.includes(requested)) return requested;

  const lower = requested.toLowerCase();
  if (modelId === "MiniMax-H3") {
    if (lower === "480p" || lower === "720p" || lower === "768p") return "768P";
    if (lower === "1080p" || lower === "2k" || lower === "4k") return "2K";
  }
  if (/^Seedance/i.test(modelId)) {
    if (requested === "768P" || lower === "2k") return spec.resolutions.includes("720p") ? "720p" : spec.defaultResolution;
    if (lower === "1080p" && !spec.resolutions.includes("1080p")) return "720p";
    if (lower === "4k" && !spec.resolutions.includes("4k")) return spec.resolutions.includes("1080p") ? "1080p" : "720p";
  }
  if (/^happyhorse/i.test(modelId)) {
    if (lower === "720p" || requested === "768P") return "720P";
    if (lower === "1080p" || lower === "2k" || lower === "4k") return "1080P";
  }
  if (/^(veo|kling|keling)/i.test(modelId)) {
    if (requested === "768P" || lower === "2k") return spec.resolutions.includes("1080p") ? "1080p" : spec.defaultResolution;
    if (lower === "4k" && !spec.resolutions.includes("4k")) return spec.resolutions.includes("1080p") ? "1080p" : spec.defaultResolution;
  }
  if (isPixVerseModel(modelId)) {
    if (lower === "480p") return "540p";
    if (lower === "2k" || lower === "4k") return "1080p";
  }
  return spec.defaultResolution;
}

function normalizeRatioForModel(modelId, requestedRatio, spec, hasReferenceImages) {
  const requested = String(requestedRatio || "");
  if (requested && spec.ratios.includes(requested)) return requested;
  if (modelId === "MiniMax-H3" && hasReferenceImages) return "adaptive";
  if (spec.ratios.includes("9:16")) return "9:16";
  if (spec.ratios.includes("16:9")) return "16:9";
  return spec.ratios[0] || "9:16";
}

function normalizeDurationForModel(modelId, requestedDuration, spec) {
  if (/^veo-3\.1/i.test(modelId)) {
    return closestAllowedDuration(requestedDuration, [4, 6, 8], spec.defaultDuration);
  }
  const [min, max] = spec.durationRange || [4, 15];
  return clampNumber(requestedDuration, min, max, spec.defaultDuration);
}

function buildImageContentItem(modelId, url) {
  const item = { type: "image_url", imageUrl: { url } };
  if (modelId === "MiniMax-H3") item.role = "reference_image";
  return item;
}

async function createVideoTasks(payload) {
  const scripts = Array.isArray(payload.scripts) ? payload.scripts.filter(Boolean) : [];
  const models = Array.isArray(payload.models) ? payload.models.filter(Boolean) : [];
  const product = payload.product && typeof payload.product === "object" && !Array.isArray(payload.product)
    ? payload.product
    : {};
  const referenceImages = normalizeReferenceImages(payload.referenceImages || payload.product || []);
  const countPerModel = Math.max(1, Math.min(6, Number(payload.countPerModel || 1)));
  if (!scripts.length) throw new Error("missing_scripts");
  if (!models.length) throw new Error("missing_models");

  const jobs = [];
  scripts.forEach((script, scriptIndex) => {
    models.forEach((model) => {
      const modelId = typeof model === "string" ? model : model.id;
      const modelName = typeof model === "string" ? model : (model.name || model.id);
      const spec = getModelSpec(modelId);
      const resolution = normalizeResolutionForModel(modelId, payload.resolution, spec);
      const ratio = normalizeRatioForModel(modelId, payload.ratio, spec, Boolean(referenceImages.length));
      const duration = normalizeDurationForModel(modelId, payload.duration, spec);

      for (let copy = 0; copy < countPerModel; copy += 1) {
        const contentText = String(script.prompt || script.script || "");
        const contentItems = [
          { type: "text", text: contentText }
        ];
        referenceImages.forEach((url) => {
          contentItems.push(buildImageContentItem(modelId, url));
        });

        let body = { model: modelId, content: contentItems, duration };
        const pixverseJob = isPixVerseModel(modelId) ? {
          prompt: contentText,
          referenceImages,
          ratio,
          quality: resolution,
          duration
        } : null;
        if (!pixverseJob) {
          if (resolution) body.resolution = resolution;
          if (ratio) body.ratio = ratio;
          if (/^Seedance2\.5/i.test(modelId)) {
            body.extra_params = { output_format: "mp4" };
          }
        } else {
          body = buildPixVerseVideoBody({ meta: { model: modelId }, pixverse: pixverseJob });
        }

        jobs.push({
          body,
          pixverse: pixverseJob,
          meta: {
            localId: crypto.randomUUID(),
            model: modelId,
            modelName,
            scriptIndex,
            copy: copy + 1,
            title: script.title || "",
            prompt: contentText,
            script: script.script || "",
            productId: String(payload.productId || product.id || ""),
            productRecordId: String(payload.productRecordId || product.recordId || ""),
            productName: String(payload.productName || product.name || ""),
            requested: {
              resolution: payload.resolution || "auto",
              ratio: payload.ratio || "",
              duration: payload.duration || ""
            },
            resolved: {
              resolution,
              ratio,
              duration,
              referenceImageCount: referenceImages.length
            }
          }
        });
      }
    });
  });

  const results = await Promise.allSettled(jobs.map(async (job) => {
    if (job.pixverse) return createPixVerseVideoTask(job);
    const response = await modelSquare("/tecpower/ai/openapi/video/create", {
      method: "POST",
      body: JSON.stringify(job.body)
    });
    const task = normalizeVideoTask(response, job.meta);
    task.requestBody = job.body;
    return task;
  }));

  return results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return { ...jobs[index].meta, status: "failed", error: result.reason?.message || "create_failed", urls: [], url: "" };
  });
}

async function getVideoTask(taskId) {
  if (String(taskId || "").startsWith("pixverse:")) {
    return getPixVerseTask(taskId);
  }
  const response = await modelSquare(`/tecpower/ai/openapi/video/task?taskId=${encodeURIComponent(taskId)}`, {
    method: "GET"
  });
  return normalizeVideoTask(response, { taskId });
}

async function getBootstrap() {
  const [productRecords, assetRecords] = await Promise.all([
    listRecords(CONFIG.productTableId),
    listRecords(CONFIG.assetTableId)
  ]);
  const products = productRecords.map(normalizeProduct);
  products.forEach((product) => { product.cover = fileUrl(product.cover); });
  const productByRecordId = new Map(products.map((product) => [product.recordId, product]));
  const allAssets = assetRecords
    .map((record) => normalizeAsset(record, productByRecordId))
    .filter((asset) => asset.review.productId)
    .map((asset) => ({ ...asset, url: fileUrl(asset.url || asset.file) }));
  const latestByAssetId = new Map();
  const versionsByAssetId = new Map();
  for (const asset of allAssets) {
    const versions = versionsByAssetId.get(asset.assetId) || [];
    versions.push(asset);
    versionsByAssetId.set(asset.assetId, versions);
    const current = latestByAssetId.get(asset.assetId);
    if (!current || asset.versionNumber > current.versionNumber || (asset.versionNumber === current.versionNumber && String(asset.updatedAt) > String(current.updatedAt))) {
      latestByAssetId.set(asset.assetId, asset);
    }
  }
  for (const versions of versionsByAssetId.values()) {
    versions.sort((a, b) => a.versionNumber - b.versionNumber || String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  const assets = [...latestByAssetId.values()]
    .map((asset) => ({ ...asset, versionHistory: versionsByAssetId.get(asset.assetId) || [asset] }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { products, assets, allVersionCount: allAssets.length };
}

async function updateAsset(user, recordId, patch) {
  const token = await getTenantToken();
  const appToken = await getAppToken();
  const fields = {};
  const now = Date.now();
  if (patch.status) fields["审核状态"] = codeToStatus(patch.status);
  if (typeof patch.published === "boolean") fields["发布状态"] = patch.published;
  if (Array.isArray(patch.tags)) fields["素材标签"] = patch.tags;
  if (typeof patch.comment === "string") fields["修改意见"] = patch.comment;
  if (patch.status) {
    fields["审核人"] = patch.reviewer || user.name || user.email;
    fields["审核时间"] = patch.reviewedAt ? new Date(patch.reviewedAt).getTime() : now;
  }
  fields["更新时间"] = now;
  const requestPath = `/bitable/v1/apps/${appToken}/tables/${CONFIG.assetTableId}/records/${recordId}`;
  try {
    return await feishu(requestPath, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields })
    });
  } catch (error) {
    if (!("审核人" in fields || "审核时间" in fields)) throw error;
    const compatibleFields = { ...fields };
    delete compatibleFields["审核人"];
    delete compatibleFields["审核时间"];
    return feishu(requestPath, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: compatibleFields })
    });
  }
}

async function createRequest(user, payload) {
  const token = await getTenantToken();
  const appToken = await getAppToken();
  const now = Date.now();
  const quantity = Math.max(1, Number(payload.quantity || 1));
  const dueAt = payload.dueAt ? new Date(payload.dueAt).getTime() : null;
  const demo = String(payload.demo || "").trim();
  const requestId = `REQ-${now}`;
  const fields = {
    "需求ID": requestId,
    "提交人邮箱": user.email,
    "关联商品ID": String(payload.productId || ""),
    "关联商品名称": String(payload.productName || ""),
    "创意方向": String(payload.direction || "Product Story"),
    "备注": String(payload.note || ""),
    "需要数量": quantity,
    "附件说明": Array.isArray(payload.attachments) ? payload.attachments.join(", ") : "",
    "需求状态": "待处理",
    "创建时间": now,
    "更新时间": now
  };
  if (dueAt) fields["期望交付日期"] = dueAt;
  if (demo) fields["Demo参考"] = { text: demo, link: demo };
  const data = await feishu(`/bitable/v1/apps/${appToken}/tables/${CONFIG.requestTableId}/records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields })
  });
  return { record: data.data.record, requestId };
}

function inferProductionProductId(payload) {
  const title = String(payload.title || payload.scriptTitle || "").toLowerCase();
  const text = [
    payload.title,
    payload.scriptTitle,
    payload.fileName,
    payload.scene,
    payload.direction,
    payload.model,
    payload.script,
    payload.prompt,
    ...(Array.isArray(payload.tags) ? payload.tags : [])
  ].filter(Boolean).join("\n").toLowerCase();

  if (title.includes("white gold") || title.includes("白金")) return "HM9965-100";
  if (title.includes("black")) return "HM9965-010";
  if (/backpack|varsity elite|背包|球包|sports bag|bag is too small|鞋仓|肩带|容量|防臭|减压|满装篮球/.test(text)) {
    return "HM9965-100";
  }
  return "";
}

async function createProductionAsset(user, payload) {
  const token = await getTenantToken();
  const appToken = await getAppToken();
  const [productRecords, assetRecords] = await Promise.all([
    listRecords(CONFIG.productTableId),
    listRecords(CONFIG.assetTableId)
  ]);
  const inferredProductId = inferProductionProductId(payload);
  const targetProductId = inferredProductId || payload.productId;
  const productRecord = productRecords.find((record) => {
    const fields = record.fields || {};
    return fields["商品ID"] === targetProductId || (!inferredProductId && record.record_id === payload.productRecordId);
  });
  if (!productRecord) throw new Error("product_not_found");

  await Promise.all([
    ensureTextField(CONFIG.assetTableId, "生成模型"),
    ensureTextField(CONFIG.assetTableId, "创意脚本"),
    ensureTextField(CONFIG.assetTableId, "生成提示词"),
    ensureTextField(CONFIG.assetTableId, "制作人")
  ]);

  const now = Date.now();
  const numericIds = assetRecords
    .map((record) => Number(String(record.fields?.["素材ID"] || "").trim()))
    .filter((value) => Number.isFinite(value));
  const nextAssetId = String(Math.max(100000, ...numericIds) + 1);
  const title = String(payload.title || payload.scriptTitle || `Creative Asset ${nextAssetId}`).trim();
  const filename = String(payload.fileName || `${nextAssetId}.mp4`).trim();
  const tags = Array.isArray(payload.tags) ? payload.tags.filter(Boolean) : ["制作端上传"];
  const fields = {
    "素材ID": nextAssetId,
    "素材名称": title,
    "文件名": filename,
    "视频URL": { text: String(payload.url || ""), link: String(payload.url || "") },
    "版本": "V1",
    "场景": String(payload.scene || payload.direction || "制作端上传"),
    "文件大小": formatSize(payload.size),
    "关联商品": [productRecord.record_id],
    "审核状态": "待审核",
    "发布状态": false,
    "素材标签": tags,
    "修改意见": "",
    "生成模型": String(payload.model || ""),
    "创意脚本": String(payload.script || ""),
    "生成提示词": String(payload.prompt || ""),
    "制作人": user.name || user.email,
    "创建时间": now,
    "更新时间": now
  };
  const data = await feishuWithRetry(`/bitable/v1/apps/${appToken}/tables/${CONFIG.assetTableId}/records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields })
  }, 5);
  return { record: data.data.record, assetId: nextAssetId };
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const user = getAuth(req);
      return json(res, user ? 200 : 401, user ? { user } : { error: "unauthorized" });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readBody(req);
      const user = await createUser(body);
      const token = createSession(user);
      return json(res, 200, { token, user });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(req);
      const user = await loginUser(body);
      const token = createSession(user);
      return json(res, 200, { token, user });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token) sessions.delete(token);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      if (!isLocalRequest(req)) requireAuth(req);
      return json(res, 200, await getBootstrap());
    }
    if (req.method === "GET" && url.pathname === "/api/skills") {
      const skills = loadSkills();
      return json(res, 200, { ok: true, skills });
    }
    if (req.method === "POST" && url.pathname === "/api/uploads") {
      if (!isLocalRequest(req)) requireAuth(req);
      const files = await readMultipartFiles(req);
      if (!files.length) return json(res, 400, { error: "no_files" });
      const uploads = await Promise.all(files.map(uploadFileToOss));
      return json(res, 200, { ok: true, uploads });
    }
    if (req.method === "POST" && url.pathname === "/api/requests") {
      const user = requireAuth(req);
      const body = await readBody(req);
      const result = await createRequest(user, body);
      return json(res, 200, { ok: true, recordId: result.record.record_id, requestId: result.requestId });
    }
    if (req.method === "POST" && url.pathname === "/api/production/assets") {
      if (!isLocalRequest(req)) return json(res, 404, { error: "local_only" });
      const body = await readBody(req);
      const defaultUser = { name: "制作端", email: "production@local" };
      const result = await createProductionAsset(defaultUser, body);
      return json(res, 200, { ok: true, recordId: result.record.record_id, assetId: result.assetId });
    }
    if (req.method === "POST" && url.pathname === "/api/production/scripts") {
      if (!isLocalRequest(req)) return json(res, 404, { error: "local_only" });
      const body = await readBody(req);
      const result = await generateProductionScripts(body);
      return json(res, 200, { ok: true, ...result });
    }
    if (req.method === "POST" && url.pathname === "/api/production/videos") {
      if (!isLocalRequest(req)) return json(res, 404, { error: "local_only" });
      const body = await readBody(req);
      const tasks = await createVideoTasks(body);
      tasks.forEach((task) => upsertTask({
        localId: task.localId,
        taskId: task.taskId || "",
        providerTaskId: task.providerTaskId || "",
        model: task.model || "",
        modelName: task.modelName || "",
        title: task.title || "",
        script: task.script || "",
        prompt: task.prompt || "",
        productId: task.productId || body.productId || body.product?.id || "",
        productRecordId: task.productRecordId || body.productRecordId || body.product?.recordId || "",
        productName: task.productName || body.productName || body.product?.name || "",
        scriptIndex: task.scriptIndex,
        copy: task.copy,
        status: task.status || "pending",
        url: task.url || "",
        urls: task.urls || [],
        message: task.message || "",
        error: task.error || "",
        requested: task.requested || {},
        resolved: task.resolved || {},
        requestBody: task.requestBody || {},
        synced: false,
        assetId: "",
        batchId: body.batchId || ""
      }));
      return json(res, 200, { ok: true, tasks });
    }
    const videoTaskMatch = url.pathname.match(/^\/api\/production\/videos\/([^/]+)$/);
    if (req.method === "GET" && videoTaskMatch) {
      if (!isLocalRequest(req)) return json(res, 404, { error: "local_only" });
      const taskId = decodeURIComponent(videoTaskMatch[1]);
      const task = await getVideoTask(taskId);
      const tasks = readTasks();
      const existing = tasks.find((t) => t.taskId === taskId);
      if (existing) {
        upsertTask({ ...existing, status: task.status, url: task.url, urls: task.urls, message: task.message });
      }
      return json(res, 200, { ok: true, task });
    }
    if (req.method === "GET" && url.pathname === "/api/production/tasks") {
      if (!isLocalRequest(req)) return json(res, 404, { error: "local_only" });
      const tasks = readTasks();
      return json(res, 200, { ok: true, tasks });
    }
    if (req.method === "GET" && url.pathname === "/api/production/batches") {
      if (!isLocalRequest(req)) return json(res, 404, { error: "local_only" });
      const batches = loadBatches();
      return json(res, 200, { ok: true, batches });
    }
    const batchMatch = url.pathname.match(/^\/api\/production\/batches\/([^/]+)$/);
    if (req.method === "GET" && batchMatch) {
      const batches = loadBatches();
      const batch = batches.find((b) => b.id === decodeURIComponent(batchMatch[1]));
      if (!batch) return json(res, 404, { error: "batch_not_found" });
      return json(res, 200, { ok: true, batch });
    }
    if (req.method === "POST" && url.pathname === "/api/production/batches") {
      if (!isLocalRequest(req)) return json(res, 404, { error: "local_only" });
      const body = await readBody(req);
      const batches = loadBatches();
      const batch = {
        id: `BATCH-${Date.now()}`,
        productId: body.productId || "",
        productName: body.productName || "",
        skillIds: body.skillIds || [],
        scriptCount: body.scriptCount || 0,
        provider: body.provider || "",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      batches.push(batch);
      saveBatches(batches);
      return json(res, 200, { ok: true, batch });
    }
    const match = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (req.method === "PUT" && match) {
      const user = requireAuth(req);
      const body = await readBody(req);
      await updateAsset(user, decodeURIComponent(match[1]), body);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "api_not_found" });
  } catch (error) {
    json(res, error.message === "unauthorized" ? 401 : 500, { error: error.message });
  }
}

function requestHandler(req, res) {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url, `http://${host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  if (url.pathname === "/production.html" && !isLocalRequest(req)) {
    return json(res, 404, { error: "local_only" });
  }
  const decoded = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(ROOT, `.${decoded}`);
  if (!filePath.startsWith(ROOT)) return json(res, 403, { error: "forbidden" });
  sendFile(res, filePath);
}

if (require.main === module) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, () => {
    console.log(`Navos Creative Asset Hub running at http://localhost:${PORT}`);
  });
}

module.exports = requestHandler;
