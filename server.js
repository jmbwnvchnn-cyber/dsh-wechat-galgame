'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHandler } = require('./src/handler');
const { loadConfig } = require('./src/config');
const { createSetup } = require('./src/setup');

const ROOT = __dirname;
const config = { ...loadConfig(ROOT) };
const handleInbound = createHandler(config);
const setup = createSetup(ROOT, config, handleInbound);
const staticRoot = path.join(ROOT, 'web');
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  response.end(payload);
}

function sendHtml(response, status, html) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

function safeConfig() {
  return {
    port: config.port,
    groupAllowlist: config.groupAllowlist,
    characterAliases: config.characterAliases,
    modelEndpoint: (() => { const endpoint = new URL(config.modelEndpoint); endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = ''; return endpoint.toString(); })(),
    bridgeTokenConfigured: Boolean(config.bridgeToken)
  };
}

function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(staticRoot, relative);
  if (!filePath.startsWith(`${staticRoot}${path.sep}`)) return sendJson(response, 404, { error: 'Not found' });
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    response.writeHead(200, { 'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    return fs.createReadStream(filePath).on('error', () => sendJson(response, 500, { error: 'Unable to read file' })).pipe(response);
  }
  if (pathname === '/') {
    return sendHtml(response, 200, '<!doctype html><meta charset="utf-8"><title>WeChat Galgame</title><h1>WeChat Galgame</h1><p>本地服务已启动。</p>');
  }
  return sendJson(response, 404, { error: 'Not found' });
}

function authorized(request) {
  if (!config.bridgeToken) return false;
  const authorization = request.headers.authorization || '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : (request.headers['x-bridge-token'] || '');
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(config.bridgeToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function receiveWebhook(request, response) {
  if (!authorized(request)) return sendJson(response, 401, { error: 'Unauthorized' });
  let size = 0;
  let body = '';
  let tooLarge = false;
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    size += Buffer.byteLength(chunk);
    if (size > 16384) { tooLarge = true; body = ''; }
    else if (!tooLarge) body += chunk;
  });
  request.on('end', async () => {
    if (tooLarge) return sendJson(response, 413, { error: 'Request too large' });
    let event;
    try { event = JSON.parse(body); } catch { return sendJson(response, 400, { error: 'Invalid JSON' }); }
    try {
      const result = await handleInbound(event);
      return sendJson(response, 200, result);
    } catch {
      return sendJson(response, 500, { error: 'Unable to process message' });
    }
  });
}

function localHost(request) {
  const host = request.headers.host;
  return typeof host === 'string' && (host === '127.0.0.1:' + config.port || host === 'localhost:' + config.port);
}
function localOrigin(request) {
  if (!request.headers.origin) return true;
  try { const origin = new URL(request.headers.origin); return origin.protocol === 'http:' && origin.host === request.headers.host && origin.origin === request.headers.origin; } catch { return false; }
}
function managementMutation(request, response, pathname) {
  if (!localOrigin(request)) return sendJson(response, 403, { error: '来源不允许' });
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) return sendJson(response, 415, { error: '请使用 JSON' });
  let size = 0, body = '', tooLarge = false;
  request.setEncoding('utf8');
  request.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 16384) { tooLarge = true; body = ''; } else if (!tooLarge) body += chunk; });
  request.on('end', async () => {
    if (tooLarge) return sendJson(response, 413, { error: '请求过大' });
    let data; try { data = JSON.parse(body); } catch { return sendJson(response, 400, { error: 'JSON 格式无效' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return sendJson(response, 400, { error: '参数无效' });
    const validString = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
    try {
      if (pathname.startsWith('/api/setup/')) {
        return sendJson(response, 200, await setup.action(pathname.slice('/api/setup/'.length), data));
      } else if (pathname === '/api/persona') {
        if (!validString(data.name, 100) || !validString(data.prompt, 4000) || !Array.isArray(data.aliases) || data.aliases.length > 30 || data.aliases.some(a => !validString(a, 100))) return sendJson(response, 400, { error: '人设参数无效' });
        await handleInbound.savePersona({ name: data.name.trim(), aliases: data.aliases.map(a => a.trim()), prompt: data.prompt.trim() });
      } else if (pathname === '/api/memory') {
        if (!validString(data.senderId, 200) || !['set', 'forget', 'clear'].includes(data.action) || (data.action === 'set' && (!validString(data.key, 80) || !validString(data.text, 200))) || (data.action === 'forget' && !validString(data.key, 200))) return sendJson(response, 400, { error: '记忆参数无效' });
        await handleInbound.manageMemory(data);
      } else if (pathname === '/api/reset-route') {
        if (!validString(data.groupId, 200) || !validString(data.senderId, 200)) return sendJson(response, 400, { error: '路线参数无效' });
        await handleInbound.resetRoute(data.groupId, data.senderId);
      } else {
        if (data.confirmation !== 'RESET') return sendJson(response, 400, { error: '请输入 RESET 确认' });
        await handleInbound.resetGame();
      }
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      const allowed = new Set(['服务实例已更改，请重新打开启动窗口', '请确认将移除的已保存群聊', '模型地址无效', '密钥过长', '更换模型地址时请填写密钥或明确清除密钥', '检测正在进行', '检测超时', '无法启动检测工具', '检测结果过大', '检测失败，请确认微信已登录且账号数据库可用', '检测结果无效', '请先检测账号并输入有效搜索词', '模型名称无效', '请先停止桥接', '请先检测账号并选择已发现的群', '正在保存设置', '操作无效', '请先完成设置']);
      return sendJson(response, 409, { error: pathname.startsWith('/api/setup/') ? (allowed.has(error.message) ? error.message : '操作失败，请检查设置') : (error.message.startsWith('游戏状态错误:') ? error.message : '保存失败，请查看服务日志') });
    }
  });
}

const server = http.createServer((request, response) => {
  let url;
  try {
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) throw new Error('Invalid target');
    url = new URL(request.url, 'http://127.0.0.1');
    if (url.origin !== 'http://127.0.0.1') throw new Error('Invalid target');
  } catch { return sendJson(response, 400, { error: 'Invalid request target' }); }
  if (request.method === 'POST' && url.pathname === '/webhook/wechat') return receiveWebhook(request, response);
  if (!localHost(request)) return sendJson(response, 403, { error: 'Host not allowed' });
  if (request.method === 'POST' && (['/api/persona', '/api/reset-route', '/api/reset-game', '/api/memory'].includes(url.pathname) || ['/api/setup/accounts', '/api/setup/groups', '/api/setup/test-model', '/api/setup/save', '/api/setup/bridge'].includes(url.pathname))) return managementMutation(request, response, url.pathname);
  if (request.method === 'GET' && url.pathname === '/api/setup/status') {
    if (!localOrigin(request)) return sendJson(response, 403, { error: 'Origin not allowed' });
    return sendJson(response, 200, setup.status());
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    if (!localOrigin(request)) return sendJson(response, 403, { error: 'Origin not allowed' });
    handleInbound.status().then(status => sendJson(response, 200, status)).catch(() => sendJson(response, 500, { error: '无法读取状态' })); return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed' });
  if (url.pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'wechat-galgame', loopbackOnly: true });
  if (url.pathname === '/api/config') return sendJson(response, 200, safeConfig());
  return serveStatic(request, response, url.pathname);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`WeChat Galgame service listening at http://127.0.0.1:${config.port}`);
  if (!config.bridgeToken) console.warn('提示: bridgeToken 尚未配置；桥接写操作将保持禁用。请复制 config.example.json 为 config.json 并填写本地令牌。');
  if (config.groupAllowlist.length === 0) console.warn('提示: groupAllowlist 为空；不会响应任何微信群消息。');
  console.log('提示: 默认仅在角色被 @提及时响应。');
});

server.on('error', (error) => {
  console.error(`服务启动失败: ${error.message}`);
  process.exitCode = 1;
});
server.on('close', setup.close);
process.on('exit', () => setup.close(true));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    setup.close();
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

module.exports = { server };
