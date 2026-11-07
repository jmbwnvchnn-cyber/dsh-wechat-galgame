'use strict';
const $ = id => document.getElementById(id);
const notice = text => { $('notice').textContent = text; };
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `请求失败 (${response.status})`);
  return result;
}
let status = null, initialized = false, busy = false, changed = false, accounts = [], selected = new Map(), found = new Map(), groupOwner = '', groupSelectionEdited = false, pollId = 0;
const editedFields = new Set();
const editing = ['detect','account','keyword','search','endpoint','name','key','clearKey','enableAccessibility','randomEventsEnabled','test','save'];
function controls() {
  const running = status && ['starting','running'].includes(status.bridge.state);
  const stoppable = status && (running || Boolean(status.bridge.pid));
  editing.forEach(id => { if ($(id)) $(id).disabled = busy || Boolean(running); });
  $('search').disabled ||= !$('account').value;
  $('save').disabled ||= !$('account').value || !selected.size;
  $('start').disabled = busy || !status?.configured || Boolean(running) || changed;
  $('stop').disabled = busy || !stoppable;
  document.querySelectorAll('#groups input').forEach(input => { input.disabled = busy || Boolean(running); });
}
function renderBridge() {
  if (!status) return;
  const b = status.bridge, labels = {stopped:'已停止',starting:'正在启动，请稍候…',running:'运行中',error:'启动或运行失败'};
  const stage = b.stageLabel ? ` · ${b.stageLabel}（本阶段 ${b.stageElapsed || 0} 秒，总计 ${b.elapsed || 0} 秒）` : '';
  $('bridge').textContent = `桥接状态：${labels[b.state] || b.state}${stage}${b.error ? ' · ' + b.error : ''}`;
  controls();
}
async function refresh() {
  const id = ++pollId;
  try {
    const next = await api('/api/setup/status');
    if (id !== pollId) return;
    status = next;
    if (!initialized) {
      initialized = true;
      if (!editedFields.has('endpoint')) $('endpoint').value = next.model.endpoint || '';
      if (!editedFields.has('name')) $('name').value = next.model.name || '';
      if (!editedFields.has('keyword')) $('keyword').value = next.preferredGroupName || '';
      if ($('enableAccessibility') && !editedFields.has('enableAccessibility')) $('enableAccessibility').checked = next.wechat.enableAccessibility === true;
      if ($('randomEventsEnabled') && !editedFields.has('randomEventsEnabled')) $('randomEventsEnabled').checked = next.game?.randomEventsEnabled !== false;
      $('key-status').textContent = next.model.keyConfigured ? '已有密钥；同一地址留空可保留。更换地址需填写新密钥或明确清除。' : '尚未保存密钥。';
      if (!next.runtime.python) notice('未找到随附 Python 运行环境，请重新解压完整分享包。');
    }
    renderBridge();
  } catch (error) { if (id === pollId) notice(`无法读取状态：${error.message}`); }
}
async function run(fn) {
  if (busy) return;
  busy = true; controls(); notice('');
  try { await fn(); } catch (error) { notice(`操作失败：${error.message}`); }
  finally { busy = false; controls(); }
}
function account() { return accounts[Number($('account').value)]; }
function renderGroups() {
  const box = $('groups'); box.replaceChildren();
  if (!found.size) { box.textContent = '没有发现群聊，请换个关键词搜索。'; return; }
  for (const [id, name] of found) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = selected.has(id);
    input.addEventListener('change', () => { if (input.checked) selected.set(id,name); else selected.delete(id); groupSelectionEdited = true; changed = true; controls(); });
    label.append(input, document.createTextNode(' ' + name)); box.append(label);
  }
  controls();
}
$('detect').addEventListener('click', () => run(async () => {
  const previous = account();
  const result = await api('/api/setup/accounts', {}); accounts = result.accounts;
  const select = $('account'); select.replaceChildren(new Option('请选择账号', ''));
  accounts.forEach((a, i) => select.add(new Option(`${a.label || a.account} · ${a.dbDir}`, String(i))));
  const index = accounts.findIndex(a => previous ? a.account === previous.account && a.dbDir === previous.dbDir : a.account === status?.wechat.account);
  select.value = index >= 0 ? String(index) : '';
  selected.clear(); found.clear(); groupOwner = ''; groupSelectionEdited = false; $('groups').textContent = '请搜索群聊。'; changed = true;
  notice(accounts.length ? '账号检测完成，请选择账号并搜索群聊。' : '未找到账号，请确认微信已登录后重试。');
}));
$('account').addEventListener('change', () => { selected.clear(); found.clear(); groupOwner = ''; groupSelectionEdited = false; $('groups').textContent = '账号已更改，请搜索群聊。'; changed = true; controls(); });
$('search').addEventListener('click', () => run(async () => {
  const a = account(); if (!a) throw Error('请先选择账号');
  const owner = `${a.dbDir}\0${a.account}`;
  if (owner !== groupOwner) { selected.clear(); found.clear(); groupOwner = owner; groupSelectionEdited = false; }
  const result = await api('/api/setup/groups', {account:a.account, dbDir:a.dbDir, keyword:$('keyword').value});
  result.groups.forEach(group => {
    found.set(group.id,group.name);
    const alreadyConfigured = status?.wechat.account === a.account && status.wechat.groupIds.includes(group.id);
    if (!groupSelectionEdited && !selected.has(group.id) && alreadyConfigured) selected.set(group.id,group.name);
  });
  renderGroups(); notice(result.truncated ? '结果过多，仅显示部分结果；请缩小搜索范围。' : `找到 ${result.groups.length} 个群。`);
}));
$('endpoint').addEventListener('input', () => {
  editedFields.add('endpoint'); changed = true;
  $('key').value = ''; $('clearKey').checked = false;
  $('key-status').textContent = '模型地址已编辑，草稿密钥已清空。请为此地址重新填写密钥，或明确清除已存密钥。';
  controls();
});
['name','key','clearKey'].forEach(id => $(id).addEventListener('input', () => { editedFields.add(id); changed = true; controls(); }));
$('enableAccessibility')?.addEventListener('change', () => { editedFields.add('enableAccessibility'); changed = true; controls(); });
$('randomEventsEnabled')?.addEventListener('change', () => { editedFields.add('randomEventsEnabled'); changed = true; controls(); });
$('keyword').addEventListener('input', () => { editedFields.add('keyword'); });
function model() { return {endpoint:$('endpoint').value.trim(), name:$('name').value.trim(), key:$('key').value, clearKey:$('clearKey').checked}; }
$('test').addEventListener('click', () => run(async () => { const result = await api('/api/setup/test-model', model()); notice(result.message); }));
$('save').addEventListener('click', () => run(async () => {
  const a = account(); if (!a || !selected.size) throw Error('请选择检测到的账号和群聊');
  const sameAccount = status.wechat.account === a.account && (!status.wechat.dbDir || status.wechat.dbDir === a.dbDir);
  const removed = status.wechat.groupIds.filter(id => !sameAccount || !selected.has(id));
  if (removed.length) {
    const names = removed.map(id => {
      const index = status.wechat.groupIds.indexOf(id);
      return status.wechat.groupNames[index] || id;
    });
    if (!confirm('保存后将移除以下已保存群聊：\n' + names.join('\n') + '\n如需保留，请取消并搜索、勾选这些群。确认移除？')) {
      notice('已取消保存；请继续搜索并选择要保留的群聊。'); return;
    }
  }
  const result = await api('/api/setup/save', {...model(), account:a.account, dbDir:a.dbDir, groupIds:[...selected.keys()], confirmRemovedGroupIds:removed, ...($('enableAccessibility') ? {enableAccessibility:$('enableAccessibility').checked === true} : {}), ...($('randomEventsEnabled') ? {randomEventsEnabled:$('randomEventsEnabled').checked === true} : {})});
  $('key').value = ''; $('clearKey').checked = false; changed = false; await refresh();
  $('key-status').textContent = status?.model.keyConfigured ? '已有密钥；同一地址留空可保留。更换地址需填写新密钥或明确清除。' : '尚未保存密钥。';
  notice(result.message + '。确认后可启动桥接。');
}));
for (const action of ['start','stop']) $(action).addEventListener('click', () => run(async () => {
  const result = await api('/api/setup/bridge', {action, instance:status.instance}); status.bridge = result.bridge; renderBridge(); await refresh();
  notice(action === 'start' ? '启动请求已提交，请等待状态确认。' : '停止请求已提交。');
}));
refresh(); setInterval(refresh, 3000);
