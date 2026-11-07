'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function createSetup(root, config, handler, options = {}) {
  const spawnProcess = options.spawn || spawn;
  const startupTimeout = options.startupTimeout || 120000;
  const pollInterval = options.pollInterval || 250;
  const stopTimeout = options.stopTimeout || 1000;
  const instance = options.instance || process.env.GAL_SERVER_INSTANCE || crypto.randomUUID();
  const python = path.join(root, 'runtime/python/python.exe');
  let accounts = [], groups = new Map(), busy = false, saving = false, stopping = false, child = null, state = 'stopped', error = '';
  const stages = {config:'读取配置', imports:'导入 Windows/UIA 依赖', window:'定位唯一微信窗口', database:'连接并核验数据库账号', uia:'只读核验聊天控件', accessibility:'启用已授权的进程无障碍标志', baseline:'读取消息启动水位', ready:'连接就绪'};
  const reasons = ['需要恰好一个可见的微信主窗口', '无法确认 UIA 已绑定唯一微信窗口',
    'UIA未启用：请在设置中明确勾选微信无障碍兼容后保存并启动，或手动启用微信 UIA',
    '微信无障碍兼容启用失败：控件核验未通过，已停止连接；请检查微信版本和权限',
    '数据库账号与配置不一致', '未找到微信消息数据库', '已有桥接进程运行', '无法读取群消息水位',
    'Windows/UIA 依赖导入失败，请检查随附运行环境和 DLL',
    '微信窗口未通过安全核验：请先手动登录，并确认窗口和控件树可读取'];
  let stage = '', startedAt = 0, stageAt = 0, endedAt = 0;
  const bridge = () => ({ state, ...(stage ? {stage, stageLabel:stages[stage], elapsed:Math.max(0,Math.floor(((endedAt || Date.now()) - startedAt)/1000)), stageElapsed:Math.max(0,Math.floor(((endedAt || Date.now()) - stageAt)/1000))} : {}), ...(child ? { pid: child.pid } : {}), ...(error ? { error } : {}) });
  const status = () => ({ instance, configured: Boolean(config.wechatBridge?.account && config.groupAllowlist.length && config.modelName && config.bridgeToken), model: {endpoint: safeEndpoint(config.modelEndpoint), name: config.modelName || '', keyConfigured: Boolean(config.modelApiKey)}, wechat: {account: config.wechatBridge?.account || '', dbDir: config.wechatBridge?.dbDir || '', groupIds: config.groupAllowlist, groupNames: config.wechatBridge?.groupNames || [], enableAccessibility:config.wechatBridge?.enableAccessibility === true}, game:{randomEventsEnabled:config.randomEventsEnabled !== false}, bridge: bridge(), runtime: {python: fs.existsSync(python), node: process.version}, preferredGroupName: config.preferredGroupName || '' });
  function safeEndpoint(value) { const u = new URL(value); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  function endpoint(value) { if (typeof value !== 'string' || value.length > 2048) throw Error('模型地址无效'); const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw Error('模型地址无效'); return u.toString(); }
  function getKey(data, url) { if (data.clearKey === true) return ''; if (typeof data.key === 'string' && data.key) { if (data.key.length > 4096) throw Error('密钥过长'); return data.key; } if (url === endpoint(config.modelEndpoint)) return config.modelApiKey || ''; throw Error('更换模型地址时请填写密钥或明确清除密钥'); }
  function probe(data) {
    return new Promise((resolve, reject) => {
      if (busy) return reject(Error('检测正在进行'));
      busy = true;
      let size = 0, done = false;
      const chunks = [];
      const p = spawnProcess(python, [path.join(root, 'scripts/setup_probe.py')], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: {...process.env, PYTHONIOENCODING: 'utf-8'}
      });
      const timer = setTimeout(() => { p.kill(); finish(Error('检测超时')); }, 60000);
      function finish(err, result) {
        if (done) return;
        done = true; clearTimeout(timer); busy = false;
        if (err) reject(err); else resolve(result);
      }
      p.on('error', () => finish(Error('无法启动检测工具')));
      p.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 262144) { p.kill(); finish(Error('检测结果过大')); }
        else chunks.push(Buffer.from(chunk));
      });
      p.on('close', code => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (code || result.error) return finish(Error('检测失败，请确认微信已登录且账号数据库可用'));
          finish(null, result);
        } catch { finish(Error('检测结果无效')); }
      });
      p.stdin.end(JSON.stringify(data));
    });
  }
  async function action(name, data) {
    if (name === 'accounts') {
      const result = await probe({action: 'accounts'});
      accounts = result.accounts; groups.clear();
      return result;
    }
    if (name === 'groups') {
      const account = accounts.find(a => a.account === data.account && (!data.dbDir || a.dbDir === data.dbDir));
      if (!account || typeof data.keyword !== 'string' || data.keyword.length > 200) throw Error('请先检测账号并输入有效搜索词');
      const result = await probe({action: 'groups', account: account.account, dbDir: account.dbDir, keyword: data.keyword});
      const cacheKey = account.dbDir + '\0' + account.account;
      const known = groups.get(cacheKey) || new Map();
      for (const group of result.groups) known.set(group.id, group.name);
      groups.set(cacheKey, known);
      return result;
    }
    if (name === 'test-model') {
      const url = endpoint(data.endpoint);
      if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200) throw Error('模型名称无效');
      const key = getKey(data, url);
      const headers = {'content-type': 'application/json'};
      if (key) headers.authorization = 'Bearer ' + key;
      try {
        const response = await fetch(url, {
          method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
          body: JSON.stringify({model: data.name, response_format: {type: 'json_object'}, max_tokens: 256,
            messages: [{role: 'system', content: '仅返回 JSON 对象，包含 reply 字符串、delta 数字和 reason 字符串。'},
              {role: 'user', content: '你好'}]})
        });
        if (!response.ok) { if (response.body) await response.body.cancel(); return {ok: false, message: '模型请求失败，状态码 ' + response.status}; }
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 65536) { await response.body.cancel().catch(() => {}); throw Error('oversized'); }
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length > 10000) throw Error('invalid');
        const result = JSON.parse(content);
        if (!result || typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 1000 ||
            typeof result.delta !== 'number' || !Number.isFinite(result.delta) ||
            typeof result.reason !== 'string' || result.reason.length > 200) throw Error('invalid');
        return {ok: true, message: '模型连接及 JSON 输出检查通过'};
      } catch { return {ok: false, message: '模型连接失败、超时或未返回有效 JSON 对象'}; }
    }
    if (name === 'save') return save(data);
    if (name === 'bridge') return manageBridge(data);
    throw Error('未知操作');
  }
  async function save(data) {
    if (child) throw Error('请先停止桥接');
    if (data.enableAccessibility !== undefined && typeof data.enableAccessibility !== 'boolean') throw Error('微信无障碍兼容必须是布尔值');
    if (data.randomEventsEnabled !== undefined && typeof data.randomEventsEnabled !== 'boolean') throw Error('随机事件开关必须为布尔值');
    const account = accounts.find(a => a.account === data.account && (!data.dbDir || a.dbDir === data.dbDir));
    const found = account && groups.get(account.dbDir + '\0' + account.account);
    if (!found || !Array.isArray(data.groupIds) || !data.groupIds.length || data.groupIds.length > 50 ||
        new Set(data.groupIds).size !== data.groupIds.length || data.groupIds.some(id => !found.has(id))) {
      throw Error('请先检测账号并选择已发现的群');
    }
    const removed = removedGroups(account, data.groupIds);
    if (removed.length && (!Array.isArray(data.confirmRemovedGroupIds) ||
        data.confirmRemovedGroupIds.length !== removed.length ||
        removed.some(id => !data.confirmRemovedGroupIds.includes(id)))) {
      throw Error('请确认将移除的已保存群聊');
    }
    const url = endpoint(data.endpoint), key = getKey(data, url);
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200) throw Error('模型名称无效');
    if (saving) throw Error('正在保存设置');
    saving = true;
    try {
      await handler.updateConfig(async () => {
        if (child) throw Error('请先停止桥接');
        if (removedGroups(account, data.groupIds).some(id => !removed.includes(id))) throw Error('请确认将移除的已保存群聊');
        const file = path.join(root, 'config.json');
        const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
        Object.assign(raw, {
          modelEndpoint: url, modelName: data.name.trim(), modelApiKey: key, botUserId: account.wxid,
          randomEventsEnabled: data.randomEventsEnabled ?? raw.randomEventsEnabled ?? true,
          groupAllowlist: data.groupIds, bridgeToken: config.bridgeToken || crypto.randomBytes(32).toString('hex'),
          wechatBridge: {...(raw.wechatBridge || {}), account: account.account, botUserId: account.wxid,
            ...(data.enableAccessibility !== undefined ? {enableAccessibility:data.enableAccessibility} : {}),
            dbDir: account.dbDir, groupNames: data.groupIds.map(id => found.get(id))}
        });
        const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try {
          fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), {mode: 0o600, flag: 'wx'});
          fs.renameSync(tmp, file);
        } finally { try { fs.unlinkSync(tmp); } catch {} }
        Object.assign(config, raw);
      });
    } finally { saving = false; }
    return {ok: true, message: '设置已保存'};
  }

  function removedGroups(account, ids) {
    const sameAccount = config.wechatBridge?.account === account.account &&
      (!config.wechatBridge?.dbDir || config.wechatBridge.dbDir === account.dbDir);
    return config.groupAllowlist.filter(id => !sameAccount || !ids.includes(id));
  }

  function stopChild(p, force = false) {
    // The owned pipe handles abrupt parent death too. Force only this child if
    // its Python watchdog fails to exit after receiving EOF.
    if (force) { p.kill(); return; }
    if (p.stopTimer) return;
    p.stdin?.end();
    p.stopTimer = setTimeout(() => { if (child === p) p.kill(); }, stopTimeout);
    p.stopTimer.unref?.();
  }

  function manageBridge(data) {
    if (data.instance !== undefined && data.instance !== instance) throw Error('服务实例已更改，请重新打开启动窗口');
    if (data.action === 'stop') {
      if (child) { stopping = true; stopChild(child); }
      return {bridge: bridge()};
    }
    if (data.action !== 'start') throw Error('操作无效');
    if (child) return {bridge: bridge()};
    if (saving) throw Error('正在保存设置');
    if (!status().configured) throw Error('请先完成设置');
    const nonce = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.join(root, 'data', 'setup'), {recursive: true});
    const ready = path.join(root, 'data', 'setup', 'ready-' + nonce + '.json');
    const progress = path.join(root, 'data', 'setup', 'progress-' + nonce + '.json');
    state = 'starting'; error = ''; stopping = false;
    stage = 'config'; startedAt = stageAt = Date.now(); endedAt = 0;
    const p = spawnProcess(python, [path.join(root, 'bridge/wechat_bridge.py')], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
      env: {...process.env, PYTHONIOENCODING: 'utf-8', GAL_BRIDGE_READY: ready, GAL_BRIDGE_PROGRESS: progress,
        GAL_BRIDGE_NONCE: nonce, GAL_BRIDGE_MANAGED: '1', WECHATAUTO_KEYS_DIR: path.join(root, 'data', 'setup', 'keys')}
    });
    child = p;
    p.stdin.on('error', () => {}); // The child may close its pipe before us.
    let diagnostic = '';
    let lastProgress = startedAt / 1000;
    if (p.stderr) p.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
    function readProgress(closed = false) {
      try {
        const update = JSON.parse(fs.readFileSync(progress, 'utf8'));
        if (!stopping && child === p && state === 'starting' && update.nonce === nonce && update.pid === p.pid &&
            Object.hasOwn(stages, update.stage) && typeof update.updatedAt === 'number' && Number.isFinite(update.updatedAt) &&
            update.updatedAt >= lastProgress && update.updatedAt <= Date.now()/1000 + 2) {
          lastProgress = update.updatedAt;
          if (stage !== update.stage) { stage = update.stage; stageAt = update.updatedAt * 1000; }
          if (reasons.includes(update.error)) { error = update.error; state = 'error'; endedAt = Date.now(); if (!closed) stopChild(p); }
        }
      } catch {}
    }
    const timer = setInterval(() => {
      readProgress();
      try {
        const r = JSON.parse(fs.readFileSync(ready, 'utf8'));
        if (!stopping && state === 'starting' && child === p && r.nonce === nonce && r.pid === p.pid &&
            typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt >= lastProgress && r.updatedAt <= Date.now()/1000 + 2) { state = 'running'; stage = 'ready'; stageAt = endedAt = Date.now(); clearInterval(timer); fs.unlinkSync(ready); try { fs.unlinkSync(progress); } catch {} }
      } catch {}
    }, pollInterval);
    const timeout = setTimeout(() => {
      if (state === 'starting' && child === p) { endedAt = Date.now(); error = `桥接启动超时：${stages[stage]}（总计 ${Math.floor((endedAt-startedAt)/1000)} 秒）`; state = 'error'; stopChild(p); }
    }, startupTimeout);
    p.on('error', () => { if (child === p) { state = 'error'; endedAt = Date.now(); error = '无法启动桥接'; } });
    p.on('close', code => {
      clearInterval(timer); clearTimeout(timeout);
      clearTimeout(p.stopTimer);
      readProgress(true);
      try { fs.unlinkSync(ready); } catch {}
      try { fs.unlinkSync(progress); } catch {}
      if (child !== p) return;
      child = null;
      endedAt ||= Date.now();
      if (state === 'error') return;
      state = stopping || code === 0 || code === null ? 'stopped' : 'error';
      if (state === 'error') {
        error = reasons.find(reason => diagnostic.includes(reason)) || '桥接启动或运行失败，请检查微信登录、账号和数据库权限';
      }
    });
    return {bridge: bridge()};
  }
  function close(force = false) { if (child) { stopping = true; stopChild(child, force); } }
  return {status,action,close};
}
module.exports = {createSetup};
