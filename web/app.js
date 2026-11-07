'use strict';
const $ = selector => document.querySelector(selector);
const notice = message => { $('#notice').textContent = message; };
async function api(path, data) {
  const options = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `操作失败 (${response.status})`);
  return result;
}
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
const time = value => { if (!value) return '未知'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? '未知' : date.toLocaleString('zh-CN'); };
const form = $('#persona-form'), factForm = $('#fact-form');
let baseline = null, dirty = false, busy = false, requestId = 0, offline = false, latestStatus = null;
const personaValue = () => ({ name: form.elements.name.value, aliases: form.elements.aliases.value.split('\n').map(s => s.trim()).filter(Boolean), prompt: form.elements.prompt.value });
function updateDirty() { dirty = baseline === null || JSON.stringify(personaValue()) !== baseline; $('#persona-state').textContent = dirty ? '有未保存的修改' : '修改后将在下一次对话中生效'; }
form.addEventListener('input', updateDirty);
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button, #persona-form input, #persona-form textarea, #fact-form input, #fact-form textarea, #profile-select').forEach(node => { node.disabled = value; });
  if (!value && !latestStatus) { $('#profile-select').disabled = true; factForm.querySelectorAll('input, textarea, button').forEach(node => { node.disabled = true; }); $('#clear-memory').disabled = true; }
  if (!value) { $('#confirm-reset').disabled = $('#confirmation').value !== 'RESET'; if (latestStatus) render(latestStatus); }
}
async function mutate(operation, success) {
  if (busy) return;
  setBusy(true); ++requestId;
  try {
    await operation();
    try { await refresh(); notice(success); }
    catch (error) { notice(`${success} 但状态刷新失败：${error.message}`); }
  } catch (error) { notice(`操作失败：${error.message}`); }
  finally { setBusy(false); }
}
function renderMemory() {
  if (!latestStatus) return;
  const select = $('#profile-select'), previous = select.value, profiles = latestStatus.profiles || [];
  select.replaceChildren();
  if (!profiles.length) select.append(element('option', '', '暂无人物档案'));
  profiles.forEach(profile => { const option = element('option', '', `${profile.nickname || profile.senderId} · ${profile.senderId}`); option.value = profile.senderId; select.append(option); });
  if (profiles.some(p => p.senderId === previous)) select.value = previous;
  const profile = profiles.find(p => p.senderId === select.value), detail = $('#profile-detail'); detail.replaceChildren();
  select.disabled = busy || !profiles.length;
  factForm.querySelectorAll('input, textarea, button').forEach(node => { node.disabled = busy || !profile; });
  $('#clear-memory').disabled = busy || !profile || !profile.facts.length;
  if (!profile) { detail.append(element('div', 'empty', '收到群友的 @ 消息后会建立档案。')); return; }
  detail.append(element('p', 'profile-meta', `首次 ${time(profile.firstSeenAt)} · 最近 ${time(profile.lastSeenAt)}`));
  if (profile.nicknameHistory?.length) detail.append(element('p', 'profile-meta', `昵称历史：${profile.nicknameHistory.join('、')}`));
  if (!profile.facts.length) detail.append(element('div', 'empty', '此人暂无长期事实。'));
  profile.facts.forEach(fact => {
    const row = element('article', 'fact'), info = element('div');
    info.append(element('strong', '', fact.text), element('div', 'route-id', `键：${fact.key} · 来源：${fact.source || '未知'} · 更新：${time(fact.updatedAt)}`));
    const actions = element('div', 'fact-actions'), edit = element('button', 'link', '编辑'), remove = element('button', 'link', '删除');
    edit.type = remove.type = 'button'; edit.disabled = remove.disabled = busy;
    edit.addEventListener('click', () => { factForm.elements.key.value = fact.key; factForm.elements.text.value = fact.text; factForm.elements.text.focus(); });
    remove.addEventListener('click', () => { if (confirm(`删除“${fact.text}”？匹配该键或内容的事实也会被删除。`)) mutate(() => api('/api/memory', { senderId: profile.senderId, action: 'forget', key: fact.key }), '事实已删除。'); });
    actions.append(edit, remove); row.append(info, actions); detail.append(row);
  });
}
function render(status) {
  latestStatus = status;
  if (baseline === null && dirty) { baseline = JSON.stringify(status.persona); updateDirty(); }
  if (!dirty && !busy) { form.elements.name.value = status.persona.name; form.elements.aliases.value = status.persona.aliases.join('\n'); form.elements.prompt.value = status.persona.prompt; baseline = JSON.stringify(personaValue()); updateDirty(); }
  $('#player-count').textContent = status.routes.length; $('#group-count').textContent = status.groups.length;
  $('#winner-name').textContent = status.winner ? status.winner.nickname : '尚未出现';
  $('#winner-detail').textContent = status.winner ? `群聊 ${status.winner.groupId} · ${time(status.winner.lockedAt)}` : '满 100 好感度即可锁定胜者';
  const routes = $('#routes'); routes.replaceChildren();
  if (!status.routes.length) routes.append(element('div', 'empty', '还没有群友路线，故事即将开始。'));
  [...status.routes].sort((a,b) => b.score-a.score).forEach(route => {
    const row = element('article', 'route'), top = element('div', 'route-top'), identity = element('div');
    identity.append(element('div', 'route-name', route.nickname), element('span', 'route-id', `群 ${route.groupId} · 用户 ${route.senderId} · ${route.stage}`));
    top.append(identity, element('span', 'score', `${route.score} / 100`));
    const bar = element('div', 'bar bipolar'), fill = element('span'), visualScore = Math.max(-100, Math.min(100, route.score));
    bar.title = '好感范围 -100～100；中线为 0';
    fill.style.width = `${Math.abs(visualScore) / 2}%`; fill.style.left = visualScore < 0 ? `${50 + visualScore / 2}%` : '50%';
    fill.style.background = visualScore < 0 ? '#c58894' : '#7bbba6';
    bar.append(element('span', 'zero-line'), fill);
    const bottom = element('div', 'route-bottom'), last = route.recentConversation.at(-1), limits = route.scoringState;
    bottom.append(element('span', '', last ? `最近变化 ${last.delta > 0 ? '+' : ''}${last.delta} · ${time(last.at)}` : '暂无变化'));
    const reset = element('button', 'link', '重置路线'); reset.type = 'button'; reset.disabled = busy || Boolean(status.winner); reset.title = status.winner ? '胜者已锁定，请先整局重置' : '';
    reset.addEventListener('click', () => { if (confirm(`确定重置 ${route.nickname} 的路线吗？`)) mutate(() => api('/api/reset-route', { groupId: route.groupId, senderId: route.senderId }), '路线已重置。'); });
    bottom.append(reset); row.append(top, bar, bottom);
    if (limits) row.append(element('div', 'route-policy', `${limits.day} 剩余正向 ${limits.remaining}/${limits.dailyCap} 分 · 冷却剩余 ${limits.cooldownRemainingSeconds} 秒 · 重复窗口 ${limits.repeatWindowHours} 小时`));
    if (last?.reason) row.append(element('div', 'route-policy', `最近计分原因：${last.reason}`)); routes.append(row);
  });
  const events = $('#event-list'); events.replaceChildren();
  if (!status.recentEvents.length) events.append(element('div', 'empty', '这里会记录故事的点滴。'));
  [...status.recentEvents].reverse().slice(0, 30).forEach(event => {
    const row = element('article', 'event');
    const labels = { game_reset: '整局已重置', route_reset: `${event.nickname || event.senderId} 的路线已重置`, winner_locked: `${event.nickname} 攻略成功，胜者已锁定`, turn_settled: `${event.nickname} 的好感度 ${event.appliedDelta > 0 ? '+' : ''}${event.appliedDelta}，目前 ${event.score} 分` };
    row.append(element('div', '', labels[event.type] || event.type), element('time', '', time(event.at)));
    if (event.reason) row.append(element('div', 'route-id', event.reason)); events.append(row);
  });
  renderMemory();
}
async function refresh() {
  const id = ++requestId;
  try {
    const status = await api('/api/status'); if (id !== requestId) return; render(status);
    if (status.modelFailure) {
      const code = status.modelFailure.code;
      const detail = /^http_\d{3}$/.test(code) ? 'HTTP ' + code.slice(5) : ({timeout:'连接超时',network:'网络中断',format:'返回格式异常'}[code] || '响应异常');
      $('#connection').textContent = `本地服务正常 · 最近一次模型请求失败（${detail}）`;
    } else $('#connection').textContent = offline ? '连接已恢复 · 状态已更新' : '连接正常 · 自动刷新已开启';
    offline = false;
  }
  catch (error) { if (id !== requestId) return; offline = true; $('#connection').textContent = `连接中断 · ${error.message} · 将自动重试`; throw error; }
}
$('#refresh').addEventListener('click', () => refresh().then(() => notice('状态已刷新。')).catch(e => notice(`无法刷新：${e.message}`)));
form.addEventListener('submit', event => { event.preventDefault(); const raw = personaValue(), value = { name: raw.name.trim(), aliases: raw.aliases, prompt: raw.prompt.trim() }; mutate(async () => { await api('/api/persona', value); baseline = JSON.stringify(value); dirty = false; if (latestStatus) latestStatus = { ...latestStatus, persona: value }; }, '角色设定已保存。'); });
$('#profile-select').addEventListener('change', () => { factForm.reset(); renderMemory(); });
factForm.addEventListener('submit', event => { event.preventDefault(); const senderId = $('#profile-select').value, key = factForm.elements.key.value, text = factForm.elements.text.value; mutate(async () => { await api('/api/memory', { senderId, action: 'set', key, text }); factForm.reset(); }, '事实已保存。'); });
$('#clear-memory').addEventListener('click', () => { const senderId = $('#profile-select').value; if (senderId && confirm('确定清除这个人的全部长期事实？相关近期对话也会清除，此操作无法撤销。')) mutate(() => api('/api/memory', { senderId, action: 'clear' }), '长期事实已清除。'); });
const dialog = $('#reset-dialog'), confirmation = $('#confirmation');
$('#open-reset').addEventListener('click', () => { confirmation.value = ''; $('#confirm-reset').disabled = true; dialog.showModal(); });
confirmation.addEventListener('input', () => { $('#confirm-reset').disabled = confirmation.value !== 'RESET'; });
$('#confirm-reset').addEventListener('click', event => { event.preventDefault(); if (confirmation.value !== 'RESET') return; mutate(async () => { await api('/api/reset-game', { confirmation: confirmation.value }); dialog.close(); }, '整局已重置。'); });
setInterval(() => { if (!document.hidden && !busy) refresh().catch(() => {}); }, 12000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh().catch(() => {}); });
refresh().catch(error => notice(`无法读取状态：${error.message}`));
