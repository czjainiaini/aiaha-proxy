#!/usr/bin/env node
'use strict';

/*
 * aiaha.xyz -> OpenAI 兼容本地反向代理
 * ------------------------------------------------------------
 * 把 aiaha.xyz(自建 Dify) 的角色对话接口，转换成 OpenAI /v1/chat/completions
 * 供 SillyTavern 等本地客户端调用。推理仍在对方服务器、消耗你自己的积分。
 *
 * 上游契约(实测确认):
 *   鉴权:   Authorization: Bearer <console_token>
 *   模型表: GET  /go/api/workspaces/model-list   (含 provider/name/status/success_rate/price)
 *   切模型: POST /go/api/apps/config
 *           {"model":{"provider","name","completion_params"},"app_id"}
 *   对话:   POST /console/api/installed-apps/{app_id}/chat-messages
 *           {"response_mode":"streaming","conversation_id":"","query","inputs":{},"parent_message_id":null}
 *           响应 SSE: data: {"event":"message","answer":"<增量>"...}
 *                     event: ping (心跳，忽略)
 *                     data: {"event":"error","message":...}
 *   停止:   POST /console/api/installed-apps/{app_id}/chat-messages/{task_id}/stop
 *   积分:   GET  /go/api/account/point
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');
// 首次运行：若无 config.json，则从模板 config.example.json 复制一份
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_PATH)) {
  try { fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH); console.log('[init] 已从 config.example.json 生成 config.json，请在监控面板的“设置”中填写账号。'); } catch (e) {}
}
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 多域名容灾：主域名 + 镜像，它们是同一"风月"平台的不同镜像；某域名连不上时自动切换
const DOMAINS = (Array.isArray(CFG.domains) && CFG.domains.length)
  ? CFG.domains.slice()
  : ['https://aiaha.xyz', 'https://aipornhub.ltd'];
let activeBase = DOMAINS[0];

let APP_ID = CFG.app_id;
const PORT = CFG.port || 8787;
const LOCAL_KEY = (CFG.local_api_key || '').trim();
const STRIP_REASONING = !!CFG.strip_reasoning;
const LOG_LEVEL = CFG.log_level || 'info';
const MODEL_ID_STYLE = CFG.model_id_style || 'verbose'; // 'verbose'=显示状态/成功率/价格; 'plain'=仅 provider/name
const HIDE_ABNORMAL = !!CFG.hide_abnormal;              // true=在 /v1/models 里隐藏"异常"状态模型
const AUTO_FALLBACK = CFG.auto_fallback !== false;      // 所选模型不可用时自动回退到 fallback_models
const AUTO_LOGIN = CFG.auto_login !== false;            // token 过期时用邮箱密码自动登录续期
const EMAIL = CFG.email || '';
const PASSWORD = CFG.password || '';
const OPEN_BROWSER = CFG.open_browser !== false;        // 启动后自动打开监控面板

let TOKEN = CFG.console_token;
let curModel = Object.assign({}, CFG.model);
const COMPLETION_PARAMS = CFG.completion_params || { temperature: 0.7, top_p: 1 };
const FALLBACKS = Array.isArray(CFG.fallback_models) ? CFG.fallback_models : [];

// ---------- 运行统计（供监控面板）----------
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');
const STATS = { startedAt: Date.now(), requests: 0, errors: 0, chars: 0, byModel: {}, recent: [], pointsSeries: [] };

function recordChat(model, ok, chars) {
  STATS.chars += chars || 0;
  if (!ok) STATS.errors++;
  STATS.byModel[model] = (STATS.byModel[model] || 0) + 1;
  STATS.recent.unshift({ t: Date.now(), model, ok: !!ok, chars: chars || 0 });
  if (STATS.recent.length > 30) STATS.recent.length = 30;
}

async function samplePoints() {
  const pts = await getPoints();
  if (pts != null && !isNaN(Number(pts))) {
    STATS.pointsSeries.push({ t: Date.now(), points: Number(pts) });
    if (STATS.pointsSeries.length > 180) STATS.pointsSeries.shift();
  }
}

// 聚合监控数据
async function buildStats() {
  const info = tokenExpiryInfo();
  const models = await fetchModelList();
  const byStatus = { smooth: 0, crowded: 0, abnormal: 0, idle: 0, other: 0 };
  let sumSucc = 0, nSucc = 0;
  for (const m of models) {
    const k = (m.status in byStatus) ? m.status : 'other';
    byStatus[k]++;
    if (m.success_rate != null && m.success_rate !== '') { sumSucc += Number(m.success_rate) || 0; nSucc++; }
  }
  const sorted = models.slice().sort((a, b) =>
    statusRank(a.status) - statusRank(b.status) || (Number(b.success_rate) || 0) - (Number(a.success_rate) || 0));
  const slim = (m) => ({ provider: m.provider_name, model: m.model_id, status: m.status, success: Number(m.success_rate) || 0, price: Number(m.model_price) || 0 });
  const latestPoints = STATS.pointsSeries.length ? STATS.pointsSeries[STATS.pointsSeries.length - 1].points : null;
  return {
    now: Date.now(),
    service: { status: 'ok', uptimeSec: Math.floor((Date.now() - STATS.startedAt) / 1000), port: PORT, activeDomain: activeBase, domains: DOMAINS, appId: APP_ID, localKeyEnabled: !!LOCAL_KEY },
    token: { daysLeft: info.daysLeft, expired: !!info.expired, expTs: info.exp, autoLogin: AUTO_LOGIN && !!EMAIL && !!PASSWORD },
    account: { points: latestPoints, email: EMAIL || null },
    model: { current: curModel.provider + '/' + curModel.name },
    models: { total: models.length, byStatus, avgSuccess: nSucc ? +(sumSucc / nSucc).toFixed(1) : null, top: sorted.slice(0, 8).map(slim), all: sorted.map(slim) },
    traffic: { requests: STATS.requests, errors: STATS.errors, chars: STATS.chars, byModel: STATS.byModel, recent: STATS.recent },
    pointsSeries: STATS.pointsSeries
  };
}

function serveDashboard(res) {
  fs.readFile(DASHBOARD_PATH, (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('dashboard.html 未找到'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// 启动后在系统默认浏览器打开网址（跨平台）
function openBrowser(url) {
  try {
    const { spawn } = require('child_process');
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { log('warn', '自动打开浏览器失败: ' + e.message); }
}

// 用指定邮箱/密码登录(不写回配置)，供设置页验证
async function tryLoginWith(domains, email, password) {
  let lastMsg = '所有域名均无法连接';
  for (const base of domains) {
    try {
      const r = await fetch(base + '/console/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': base, 'Referer': base + '/', 'x-language': 'zh-Hans' }, body: JSON.stringify({ email, password, remember_me: true, interface_language: 'zh-Hans' }) });
      const j = await r.json().catch(() => null);
      const tok = j && (typeof j.data === 'string' ? j.data : (j.data && j.data.access_token) || j.access_token);
      if (tok && String(tok).split('.').length === 3) return { ok: true, token: tok, base };
      lastMsg = (j && (j.message || (typeof j.data === 'string' ? j.data : null))) || ('HTTP ' + r.status);
    } catch (e) { lastMsg = e.message; }
  }
  return { ok: false, msg: lastMsg };
}

// 从(可能是链接的)输入中提取 app_id (UUID)：支持粘贴 aiaha 角色卡链接或纯 UUID
function extractAppId(s) {
  const m = String(s || '').match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : '';
}

// 读取当前配置(脱敏)供设置页展示：密码/token 不回传明文
function readConfigSafe() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const info = tokenExpiryInfo();
  return {
    email: c.email || '', hasPassword: !!c.password, hasToken: !!c.console_token,
    tokenDaysLeft: info.daysLeft, tokenExpired: !!info.expired,
    app_id: c.app_id || '', model: c.model || { provider: '', name: '' },
    completion_params: c.completion_params || {}, fallback_models: c.fallback_models || [],
    port: c.port || 8787, local_api_key: c.local_api_key || '', domains: c.domains || [],
    auto_login: c.auto_login !== false, auto_fallback: c.auto_fallback !== false,
    strip_reasoning: !!c.strip_reasoning, hide_abnormal: !!c.hide_abnormal,
    open_browser: c.open_browser !== false, model_id_style: c.model_id_style || 'verbose'
  };
}

// 保存设置（合并写回；password 为空则不改；verify=true 时先登录验证）
async function saveConfig(patch) {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const k of ['email', 'local_api_key', 'model_id_style']) if (typeof patch[k] === 'string') c[k] = patch[k].trim();
  if (typeof patch.app_id === 'string' && patch.app_id.trim()) c.app_id = extractAppId(patch.app_id) || patch.app_id.trim();
  if (typeof patch.password === 'string' && patch.password.length) c.password = patch.password;
  if (patch.port && !isNaN(+patch.port)) c.port = +patch.port;
  if (patch.model && patch.model.provider && patch.model.name) c.model = { provider: String(patch.model.provider).trim(), name: String(patch.model.name).trim() };
  if (Array.isArray(patch.domains)) c.domains = patch.domains.map(s => String(s).trim()).filter(Boolean);
  if (Array.isArray(patch.fallback_models)) c.fallback_models = patch.fallback_models;
  if (patch.completion_params && typeof patch.completion_params === 'object') c.completion_params = patch.completion_params;
  for (const b of ['auto_login', 'auto_fallback', 'strip_reasoning', 'hide_abnormal', 'open_browser']) if (typeof patch[b] === 'boolean') c[b] = patch[b];
  let verified = null;
  if (patch.verify && c.email && c.password) {
    const res = await tryLoginWith((c.domains && c.domains.length) ? c.domains : DOMAINS, c.email, c.password);
    if (!res.ok) return { ok: false, verified: false, message: '账号验证失败: ' + res.msg };
    verified = true; c.console_token = res.token;
  }
  try { fs.writeFileSync(CONFIG_PATH + '.bak', fs.readFileSync(CONFIG_PATH)); } catch (e) {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n', 'utf8');
  if (c.app_id && c.app_id !== APP_ID) { APP_ID = c.app_id; log('info', '已切换角色卡 app_id (当前会话即时生效): ' + APP_ID); }
  return { ok: true, verified, note: '已保存。角色卡 app_id 已即时生效；其余部分设置需重启代理后生效。' };
}

// ---------- 工具 ----------
function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if ((order[level] ?? 2) <= (order[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] [${level}]`, ...args);
  }
}

// ---------- 统一请求层：多域名容灾 + 自动登录续期 ----------
function buildHeaders(base, { sse = false, noAuth = false } = {}) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': sse ? '*/*' : 'application/json',
    'Origin': base,
    'Referer': base + '/',
    'x-language': 'zh-Hans',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) aiaha-proxy'
  };
  if (!noAuth && TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
  return h;
}

function domainOrder() {
  return [activeBase, ...DOMAINS.filter(d => d !== activeBase)];
}

// 对某 path 依次尝试各域名；连接失败或被拦(403/429/5xx)自动切下一个镜像；401 则自动登录续期后重试一次
async function fetchApi(pathname, opts = {}) {
  const { method = 'GET', body = null, sse = false, signal = null, noAuth = false, _retried = false } = opts;
  let lastErr = 'unknown';
  for (const base of domainOrder()) {
    try {
      const resp = await fetch(base + pathname, { method, headers: buildHeaders(base, { sse, noAuth }), body, signal });
      if ([403, 429, 502, 503, 504].includes(resp.status) && DOMAINS.length > 1) {
        lastErr = 'HTTP ' + resp.status + ' @ ' + base; log('warn', `${base} 返回 ${resp.status}，切换镜像域名`); continue;
      }
      if (base !== activeBase) { log('info', '已切换到镜像域名: ' + base); activeBase = base; }
      if (resp.status === 401 && !noAuth && !_retried && await ensureRelogin()) {
        return fetchApi(pathname, Object.assign({}, opts, { _retried: true }));
      }
      return resp;
    } catch (e) { lastErr = (e && e.message || String(e)) + ' @ ' + base; continue; }
  }
  throw new Error('所有域名均不可用: ' + lastErr);
}

// 用邮箱密码登录换取新 token，并写回 config.json
async function loginAndRefreshToken() {
  if (!EMAIL || !PASSWORD) { log('warn', '未配置 email/password，无法自动登录续期'); return false; }
  try {
    const r = await fetchApi('/console/api/login', {
      method: 'POST', noAuth: true,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, remember_me: true, interface_language: 'zh-Hans' })
    });
    const j = await r.json().catch(() => null);
    const tok = j && (typeof j.data === 'string' ? j.data : (j.data && j.data.access_token) || j.access_token);
    if (!tok || String(tok).split('.').length !== 3) {
      log('error', '自动登录失败: ' + (j && (j.message || j.data) || ('HTTP ' + r.status))); return false;
    }
    TOKEN = tok;
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg.console_token = tok;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    } catch (e) { log('warn', 'token 写回 config.json 失败(仅当前内存生效): ' + e.message); }
    const info = tokenExpiryInfo();
    log('info', `自动登录成功，新 token 有效期约 ${info.daysLeft != null ? info.daysLeft.toFixed(1) : '?'} 天`);
    return true;
  } catch (e) { log('error', '自动登录异常: ' + e.message); return false; }
}

let _reloginInFlight = null;
function ensureRelogin() {
  if (!AUTO_LOGIN || !EMAIL || !PASSWORD) return Promise.resolve(false);
  if (!_reloginInFlight) _reloginInFlight = loginAndRefreshToken().finally(() => { _reloginInFlight = null; });
  return _reloginInFlight;
}

// 检查 token 是否过期(JWT exp)
function tokenExpiryInfo() {
  try {
    const p = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return { exp: p.exp, expired: p.exp && p.exp < now, daysLeft: p.exp ? ((p.exp - now) / 86400) : null };
  } catch (e) { return { exp: null, expired: false, daysLeft: null }; }
}

// 设置上游 app 绑定的模型(服务器端持久化)
async function setUpstreamModel(model) {
  const body = {
    model: { provider: model.provider, name: model.name, completion_params: COMPLETION_PARAMS },
    app_id: APP_ID
  };
  const r = await fetchApi('/go/api/apps/config', { method: 'POST', body: JSON.stringify(body) });
  const txt = await r.text();
  log('debug', 'setModel', model.provider + '/' + model.name, r.status, txt.slice(0, 120));
  return r.ok;
}

// 查询积分余额
async function getPoints() {
  try {
    const r = await fetchApi('/go/api/account/point');
    const j = await r.json();
    return j && j.data ? j.data.points : null;
  } catch (e) { return null; }
}

// ---------- 官网模型列表(带 60s 缓存) ----------
const STATUS_CN = { smooth: '通畅', crowded: '拥挤', abnormal: '异常', idle: '空闲', normal: '正常' };
let _modelCache = { at: 0, models: [] };

async function fetchModelList(force) {
  if (!force && (Date.now() - _modelCache.at) < 60000 && _modelCache.models.length) return _modelCache.models;
  try {
    const r = await fetchApi('/go/api/workspaces/model-list?channel=undefined&x_lang=zh-Hans');
    const j = await r.json();
    const models = (j && j.data && j.data.models) || [];
    if (models.length) _modelCache = { at: Date.now(), models };
    return _modelCache.models;
  } catch (e) { log('warn', '拉取模型列表失败:', e.message); return _modelCache.models; }
}

function statusRank(s) { return ({ smooth: 0, normal: 0, idle: 1, crowded: 2, abnormal: 3 })[s] ?? 9; }

// provider/name  +  可选的"状态 成功率 价格"后缀
function modelDisplayId(m) {
  const base = m.provider_name + '/' + m.model_id;
  if (MODEL_ID_STYLE === 'plain') return base;
  const st = STATUS_CN[m.status] || m.status || '';
  const rate = (m.success_rate != null && m.success_rate !== '') ? (Math.round(Number(m.success_rate) * 10) / 10 + '%') : '';
  const price = m.model_price ? ('x' + m.model_price) : '';
  const tail = [st, rate, price].filter(Boolean).join(' ');
  return tail ? (base + ' | ' + tail) : base;
}

// 从(可能带后缀的)模型 id 解析出 { provider, name }
function parseModelId(id) {
  let s = String(id || '').trim();
  s = s.split(/[|｜]/)[0].trim();  // 去掉 verbose 后缀
  const i = s.indexOf('/');
  if (i < 0) return null;
  const provider = s.slice(0, i).trim();
  const name = s.slice(i + 1).trim();
  if (!provider || !name) return null;
  return { provider, name };
}

// ---------- OpenAI messages -> 单条 query 打包(路线B) ----------
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : (c && c.text) || '')).join('');
  }
  return content == null ? '' : String(content);
}

function packMessages(messages) {
  const label = { system: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' };
  const parts = [];
  for (const m of messages) {
    const text = contentToText(m.content).trim();
    if (!text) continue;
    const who = m.name || label[m.role] || m.role || 'User';
    parts.push(`### ${who}\n${text}`);
  }
  // 末尾引导模型以助手身份续写
  parts.push('### Assistant\n');
  return parts.join('\n\n');
}

// 可选：去掉 <details><summary>思维链...</summary>...</details> 推理块
function maybeStripReasoning(text) {
  if (!STRIP_REASONING) return text;
  return text.replace(/<details[\s\S]*?<\/details>/gi, '').replace(/^\s+/, '');
}

// ---------- 调上游对话 ----------
async function upstreamChat(query, { signal } = {}) {
  const body = {
    response_mode: 'streaming',
    conversation_id: '',
    query,
    inputs: {},
    parent_message_id: null
  };
  return fetchApi('/console/api/installed-apps/' + APP_ID + '/chat-messages', {
    method: 'POST', body: JSON.stringify(body), sse: true, signal
  });
}

// ---------- 带"早期错误自动回退"的对话流 ----------
// 依次尝试 [requested, ...fallbacks]；某模型在"尚未产出任何内容"时报错(如供应商不存在)则换下一个。
// 产出事件: {type:'start',model} | {type:'delta',text} | {type:'end'} | {type:'fatal',message}
async function* chatStream(query, requestedModel) {
  const chain = [];
  const push = (m) => {
    if (m && m.provider && m.name && !chain.find(c => c.provider === m.provider && c.name === m.name)) chain.push(m);
  };
  push(requestedModel);
  if (AUTO_FALLBACK) FALLBACKS.forEach(push);
  if (!chain.length) push(curModel);

  let lastErr = '未知错误';
  for (const m of chain) {
    if (m.provider !== curModel.provider || m.name !== curModel.name) {
      const ok = await setUpstreamModel(m);
      if (ok) curModel = { provider: m.provider, name: m.name };
    }
    let resp;
    try { resp = await upstreamChat(query); }
    catch (e) { lastErr = 'fetch failed: ' + e.message; log('warn', `模型 ${m.provider}/${m.name} 连接失败: ${e.message}`); continue; }
    if (!resp.ok || !resp.body) { lastErr = 'HTTP ' + resp.status; log('warn', `模型 ${m.provider}/${m.name} 返回 HTTP ${resp.status}`); continue; }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', emitted = false, earlyErr = null;
    read:
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (e) {
        if (emitted) { yield { type: 'delta', text: '\n\n[代理错误] ' + e.message }; yield { type: 'end' }; return; }
        earlyErr = e.message; break;
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('event:') || !t.startsWith('data:')) continue;
          const pl = t.slice(5).trim();
          if (!pl || pl === '[DONE]') continue;
          let obj; try { obj = JSON.parse(pl); } catch (e) { continue; }
          if (obj.event === 'error') {
            const em = obj.message || obj.code || 'error';
            if (!emitted) { earlyErr = em; try { reader.cancel(); } catch (e) {} break read; }
            yield { type: 'delta', text: '\n\n[上游错误] ' + em };
            try { reader.cancel(); } catch (e) {}
            yield { type: 'end' }; return;
          } else if (obj.event === 'message' || obj.event === 'agent_message') {
            if (typeof obj.answer === 'string' && obj.answer.length) {
              if (!emitted) { emitted = true; yield { type: 'start', model: m }; }
              yield { type: 'delta', text: obj.answer };
            }
          }
        }
      }
    }
    if (earlyErr) { lastErr = earlyErr; log('warn', `模型 ${m.provider}/${m.name} 早期错误: ${earlyErr}，尝试下一个渠道`); continue; }
    yield { type: 'end' }; return;
  }
  yield { type: 'fatal', message: lastErr };
}

// ---------- HTTP 响应助手 ----------
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(s)
  });
  res.end(s);
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
}

function chunkObj(id, created, model, delta, finish) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish || null }]
  };
}

function checkAuth(req) {
  if (!LOCAL_KEY) return true;
  const h = req.headers['authorization'] || '';
  const key = h.replace(/^Bearer\s+/i, '').trim();
  return key === LOCAL_KEY;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type'
    });
    return res.end();
  }

  // 监控面板页面
  if ((p === '/' || p === '/dashboard') && req.method === 'GET') {
    return serveDashboard(res);
  }
  if (p === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'aiaha-proxy', model: curModel, app_id: APP_ID });
  }
  // 监控面板聚合数据
  if (p === '/api/stats' && req.method === 'GET') {
    return sendJson(res, 200, await buildStats());
  }
  // 设置：读取(脱敏) / 保存
  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, readConfigSafe());
  }
  if (p === '/api/config' && req.method === 'POST') {
    let body; try { body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '')); } catch (e) { return sendJson(res, 400, { ok: false, message: 'invalid json body' }); }
    try { const r = await saveConfig(body); return sendJson(res, r.ok ? 200 : 400, r); } catch (e) { return sendJson(res, 500, { ok: false, message: e.message }); }
  }
  // 验证角色卡链接/ID 是否有效
  if (p === '/api/validate-app' && req.method === 'GET') {
    const appId = extractAppId(url.searchParams.get('app_id') || url.searchParams.get('link') || '');
    if (!appId) return sendJson(res, 200, { ok: true, valid: false, message: '未能识别 app_id：请粘贴角色卡链接或 36 位 UUID' });
    try {
      const r = await fetchApi('/go/api/apps/config?app_id=' + appId);
      const j = await r.json().catch(() => null);
      const valid = !!(r.ok && j && j.code === 100000 && j.data);
      const model = valid && j.data.model ? (j.data.model.provider + '/' + j.data.model.name) : null;
      return sendJson(res, 200, { ok: true, valid, appId, model, message: valid ? '角色卡有效，可使用' : ((j && (j.msg || j.message)) || '无法访问该角色卡') });
    } catch (e) { return sendJson(res, 200, { ok: true, valid: false, appId, message: e.message }); }
  }

  // 查积分
  if (p === '/points' && req.method === 'GET') {
    const pts = await getPoints();
    return sendJson(res, 200, { points: pts });
  }

  // OpenAI: 列出模型 —— 全量拉取官网模型 + 状态/成功率/价格
  if (p === '/v1/models' && req.method === 'GET') {
    let models = await fetchModelList();
    if (HIDE_ABNORMAL) models = models.filter(m => m.status !== 'abnormal');
    const sorted = models.slice().sort((a, b) =>
      statusRank(a.status) - statusRank(b.status) || (Number(b.success_rate) || 0) - (Number(a.success_rate) || 0));
    const now = Math.floor(Date.now() / 1000);
    const data = sorted.map(m => ({
      id: modelDisplayId(m),
      object: 'model',
      created: now,
      owned_by: m.provider_name,
      // 附加(非标准)字段，方便其它客户端/调试查看
      status: m.status,
      success_rate: m.success_rate,
      price: m.model_price,
      model_id: m.model_id
    }));
    log('info', `/v1/models 返回 ${data.length} 个模型`);
    return sendJson(res, 200, { object: 'list', data });
  }

  // OpenAI: 对话补全
  if (p === '/v1/chat/completions' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: { message: 'invalid local api key' } });

    let payload;
    try { payload = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '')); }
    catch (e) { return sendJson(res, 400, { error: { message: 'invalid json body' } }); }

    const messages = payload.messages || [];
    const wantStream = payload.stream !== false; // 默认流式
    const query = packMessages(messages);
    const id = 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const created = Math.floor(Date.now() / 1000);
    const requestedModel = parseModelId(payload.model) || null;
    const reqLabel = requestedModel ? (requestedModel.provider + '/' + requestedModel.name) : '(默认)';

    log('info', `chat: ${messages.length} 条消息, 打包 ${query.length} 字符, 模型=${reqLabel}, stream=${wantStream}`);
    STATS.requests++;

    // ---- 流式返回 ----
    if (wantStream) {
      sseHead(res);
      let served = reqLabel, started = false, gotAny = false, chars = 0, hadFatal = false;
      const emitRole = () => { if (!started) { started = true; res.write('data: ' + JSON.stringify(chunkObj(id, created, served, { role: 'assistant' })) + '\n\n'); } };
      try {
        for await (const ev of chatStream(query, requestedModel)) {
          if (res.writableEnded) break;
          if (ev.type === 'start') {
            served = ev.model.provider + '/' + ev.model.name;
            emitRole();
          } else if (ev.type === 'delta') {
            emitRole();
            const out = STRIP_REASONING ? maybeStripReasoning(ev.text) : ev.text;
            if (out) { gotAny = true; chars += out.length; res.write('data: ' + JSON.stringify(chunkObj(id, created, served, { content: out })) + '\n\n'); }
          } else if (ev.type === 'fatal') {
            hadFatal = true;
            emitRole();
            const info = tokenExpiryInfo();
            const hint = info.expired ? '（console_token 已过期，请重新提取）' : '';
            res.write('data: ' + JSON.stringify(chunkObj(id, created, served, { content: '\n[代理错误] 候选模型均不可用: ' + ev.message + hint })) + '\n\n');
          }
        }
      } catch (e) {
        log('error', 'stream 处理异常:', e.message);
        if (!res.writableEnded) { emitRole(); res.write('data: ' + JSON.stringify(chunkObj(id, created, served, { content: '\n[代理错误] ' + e.message })) + '\n\n'); }
      }
      if (!res.writableEnded) {
        res.write('data: ' + JSON.stringify(chunkObj(id, created, served, {}, 'stop')) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }
      recordChat(served, gotAny && !hadFatal, chars);
      log('info', `stream 完成, 实际模型=${served}, 有内容=${gotAny}`);
      return;
    }

    // ---- 非流式返回：累积后一次性返回 ----
    let full = '', served = reqLabel, fatal = null;
    try {
      for await (const ev of chatStream(query, requestedModel)) {
        if (ev.type === 'start') served = ev.model.provider + '/' + ev.model.name;
        else if (ev.type === 'delta') full += ev.text;
        else if (ev.type === 'fatal') fatal = ev.message;
      }
    } catch (e) { fatal = fatal || e.message; }

    if (fatal && !full) {
      recordChat(served, false, 0);
      const info = tokenExpiryInfo();
      const hint = info.expired ? ' (console_token 已过期，请重新提取)' : '';
      return sendJson(res, 502, { error: { message: '候选模型均不可用: ' + fatal + hint } });
    }
    recordChat(served, !!full, full.length);
    const content = STRIP_REASONING ? maybeStripReasoning(full) : full;
    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model: served,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  }

  return sendJson(res, 404, { error: { message: 'not found: ' + p } });
});

// ---------- 启动 ----------
(async function start() {
  let info = tokenExpiryInfo();
  if (info.daysLeft != null) log('info', `console_token 剩余有效期约 ${info.daysLeft.toFixed(1)} 天`);
  // token 已过期或不足 2 天：尝试用邮箱密码自动登录续期
  if (AUTO_LOGIN && (info.expired || info.daysLeft == null || info.daysLeft < 2)) {
    if (EMAIL && PASSWORD) {
      log('info', 'token 即将/已过期，尝试自动登录续期...');
      await ensureRelogin();
      info = tokenExpiryInfo();
    } else if (info.expired) {
      log('warn', '⚠️  console_token 已过期，且未配置 email/password；请手动刷新或填写账号密码以自动续期');
    }
  }
  if (CFG.set_model_on_start) {
    const ok = await setUpstreamModel(curModel);
    log('info', `启动时设置默认模型 ${curModel.provider}/${curModel.name}: ${ok ? '成功' : '失败'}`);
  }
  await samplePoints();
  const pts = STATS.pointsSeries.length ? STATS.pointsSeries[STATS.pointsSeries.length - 1].points : null;
  log('info', `当前积分余额: ${pts != null ? pts : '(查询失败)'}`);
  setInterval(samplePoints, 60000); // 每分钟采样积分，供面板绘制消耗曲线
  const ml = await fetchModelList(true);
  log('info', `已加载官网模型 ${ml.length} 个（SillyTavern 下拉框可选，带状态/成功率）`);

  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  aiaha-proxy 已启动 ✅');
    console.log('  监控面板:         http://127.0.0.1:' + PORT + '/dashboard');
    console.log('  OpenAI 兼容地址:  http://127.0.0.1:' + PORT + '/v1');
    console.log('  本地 API Key:     ' + (LOCAL_KEY || '(无，未启用)'));
    console.log('  默认模型:         ' + curModel.provider + '/' + curModel.name);
    console.log('  可用模型:         ' + ml.length + ' 个（在 SillyTavern 模型下拉框选择即可切换）');
    console.log('');
    console.log('  SillyTavern 填法: Chat Completion -> Custom (OpenAI-compatible)');
    console.log('    - Endpoint / Proxy URL: http://127.0.0.1:' + PORT + '/v1');
    console.log('    - API Key:              ' + (LOCAL_KEY || '(留空)'));
    console.log('');
    if (OPEN_BROWSER) { openBrowser('http://127.0.0.1:' + PORT + '/dashboard'); console.log('  已在默认浏览器打开监控面板。'); }
  });
})();
