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

let tenantTokenCache = null;
let appTokenCache = null;
let userRecordsCache = null;
const sessions = new Map();

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
      requireAuth(req);
      return json(res, 200, await getBootstrap());
    }
    if (req.method === "POST" && url.pathname === "/api/uploads") {
      requireAuth(req);
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
