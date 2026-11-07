'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this._textContent = ''; this.disabled = false; this.checked = false; this.type = ''; }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; this.children = []; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { this.children.push(...nodes); if (this.tag === 'select' && !this.value && nodes[0]) this.value = nodes[0].value; }
  add(option) { this.children.push(option); }
  replaceChildren(...nodes) { this.children = []; if (this.tag === 'select') this.value = ''; this.append(...nodes); }
  querySelectorAll() { return []; }
}
const ids = ['notice','detect','account','keyword','search','groups','endpoint','name','key','clearKey','enableAccessibility','randomEventsEnabled','key-status','test','save','bridge','start','stop'];
const nodes = Object.fromEntries(ids.map(id => [id, new Node(id === 'account' ? 'select' : 'div')]));
const document = {
  getElementById: id => nodes[id],
  querySelectorAll: selector => selector === '#groups input' ? nodes.groups.children.map(label => label.children[0]).filter(node => node?.type === 'checkbox') : [],
  createElement: tag => new Node(tag),
  createTextNode: text => ({textContent:text}),
};
let calls = [], interval, failNextTest = false, failBridgeStart = false;
let confirmRemoval = false, confirmations = [];
let savedWechat = {account:'wxid_a_abcd',dbDir:'dbA',groupIds:['a@chatroom','unseen@chatroom'],groupNames:['Alpha','Hidden Beta']};
const status = () => ({instance:'ui-instance',configured:true, model:{endpoint:'https://saved.example/v1/chat/completions',name:'saved-model',keyConfigured:true}, wechat:savedWechat, bridge:{state:'stopped'},runtime:{python:true,node:'v22'},preferredGroupName:'Alpha'});
const route = (path, body) => {
  calls.push({path,body});
  if (path === '/api/setup/status') return status();
  if (path === '/api/setup/accounts') return {accounts:[{account:'wxid_a_abcd',wxid:'wxid_a',label:'A',dbDir:'dbA'},{account:'wxid_b_abcd',wxid:'wxid_b',label:'B',dbDir:'dbB'}]};
  if (path === '/api/setup/groups') return {groups:body.account === 'wxid_a_abcd' ? [{id:'a@chatroom',name:'Alpha'}] : [{id:'b@chatroom',name:'Beta'}],truncated:false};
  if (path === '/api/setup/test-model') { if (failNextTest) { failNextTest = false; throw Object.assign(Error('offline'), {apiError:true}); } return {ok:true,message:'测试通过'}; }
  if (path === '/api/setup/save') {
    savedWechat = {account:body.account,dbDir:body.dbDir,groupIds:body.groupIds,groupNames:body.groupIds.map(id => id === 'a@chatroom' ? 'Alpha' : 'Beta')};
    return {ok:true,message:'设置已保存'};
  }
  if (path === '/api/setup/bridge') return {bridge:{state:body.action === 'start' ? 'starting' : 'stopped',pid:body.action === 'start' ? 55 : undefined}};
  throw Error(`unexpected route ${path}`);
};
const context = {
  document,
  confirm: message => { confirmations.push(message); return confirmRemoval; },
  Option: function Option(text, value) { this.textContent = text; this.value = value; },
  fetch: async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (path === '/api/setup/bridge' && body.action === 'start' && failBridgeStart) { calls.push({path,body}); failBridgeStart = false; return {ok:false,status:409,json:async()=>({error:'模拟启动失败'})}; }
    return {ok:true,status:200,json:async()=>route(path,body)};
  },
  setInterval: fn => { interval = fn; },
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const fire = async (id, type = 'click') => { await nodes[id].listeners[type]({target:nodes[id]}); await tick(); };
(async () => {
  assert.match(fs.readFileSync('web/setup.html','utf8'),/id="randomEventsEnabled"/,'settings markup must include the actual event checkbox');
  vm.runInNewContext(fs.readFileSync('web/setup.js','utf8'), context);
  nodes.endpoint.value = 'https://typed-before-status.example/v1';
  nodes.endpoint.listeners.input();
  await tick();
  assert.equal(nodes.endpoint.value,'https://typed-before-status.example/v1','the first status response must preserve early typing');
  nodes.name.value = 'my-model'; nodes.name.listeners.input();
  interval(); await tick();
  assert.equal(nodes.endpoint.value,'https://typed-before-status.example/v1','polling must not overwrite a draft');
  assert.equal(nodes.name.value,'my-model','polling must not overwrite a draft');
  assert.equal(calls.some(c => ['/api/setup/test-model','/api/setup/bridge'].includes(c.path)),false,'no model call or bridge startup on load');
  assert.equal(nodes.enableAccessibility.checked,false,'default consent checkbox is unchecked');
  assert.equal(nodes.randomEventsEnabled.checked,true,'random events default to enabled');
  nodes.randomEventsEnabled.checked=false;await fire('randomEventsEnabled','change');
  interval();await tick();assert.equal(nodes.randomEventsEnabled.checked,false,'polling preserves event toggle draft');

  await fire('detect');
  assert.equal(nodes.account.children.length,3,'select.add must populate the placeholder and both detected accounts');
  assert.match(nodes.account.children[1].textContent,/A.*dbA/);
  assert.match(nodes.account.children[2].textContent,/B.*dbB/);
  assert.match(nodes.notice.textContent,/账号检测完成/,'detect must finish successfully, rather than swallowing a mock DOM error');
  nodes.account.value = '0'; await fire('account','change');
  await fire('search');
  assert.equal(nodes.groups.children.length,1);
  assert.equal(nodes.groups.children[0].children[0].checked,true,'the saved group should be preselected after detection');
  nodes.name.value = 'model-only-edit'; await fire('name','input');
  await fire('save');
  assert.equal(calls.some(c => c.path === '/api/setup/save'),false,'cancelled removal must not post a save');
  assert.match(confirmations.at(-1),/Hidden Beta/,'unseen saved groups are named before a model-only save can remove them');
  assert.match(nodes.notice.textContent,/已取消保存/);
  confirmRemoval = true; await fire('save');
  assert.equal(calls.findLast(c => c.path === '/api/setup/save').body.enableAccessibility,false);
  assert.deepEqual(calls.findLast(c => c.path === '/api/setup/save').body.confirmRemovedGroupIds,['unseen@chatroom']);
  nodes.account.value = '1'; await fire('account','change');
  assert.equal(nodes.groups.children.length,0,'changing account clears previous search results');
  assert.equal(nodes.save.disabled,true,'changing account clears prior group choices');
  await fire('search');
  assert.equal(nodes.groups.children[0].children[0].checked,false,'a group from another account is never carried over');
  const beta = nodes.groups.children[0].children[0]; beta.checked = true; await beta.listeners.change(); await tick();

  nodes.key.value = 'one-time-secret';
  await fire('key','input');
  await fire('test');
  assert.equal(calls.filter(c => c.path === '/api/setup/test-model').length,1,'testing occurs only after an explicit click');
  assert.equal(calls.findLast(c => c.path === '/api/setup/test-model').body.key,'one-time-secret');
  nodes.endpoint.value = 'https://new-service.example/v1'; await fire('endpoint','input');
  assert.equal(nodes.key.value,'','editing the endpoint clears the old endpoint draft key');
  assert.match(nodes['key-status'].textContent,/草稿密钥已清空/);
  await fire('test');
  const newServiceTest = calls.findLast(c => c.path === '/api/setup/test-model');
  assert.equal(newServiceTest.body.endpoint,'https://new-service.example/v1');
  assert.equal(newServiceTest.body.key,'','testing service B must never send service A draft key');
  failNextTest = true; await fire('test');
  assert.match(nodes.notice.textContent,/操作失败/);
  assert.equal(nodes.test.disabled,false,'a failed model test leaves controls available for retry');
  nodes.clearKey.checked = true;
  nodes.enableAccessibility.checked = true; await fire('enableAccessibility','change');
  interval(); await tick(); assert.equal(nodes.enableAccessibility.checked,true,'polling preserves explicit consent draft');
  await fire('save');
  const save = calls.findLast(c => c.path === '/api/setup/save');
  assert.equal(save.body.clearKey,true,'explicit key clearing is included in the save request');
  assert.equal(save.body.enableAccessibility,true,'only explicit checkbox selection enables compatibility');
  assert.equal(save.body.randomEventsEnabled,false,'event toggle is saved explicitly');
  assert.deepEqual(save.body.confirmRemovedGroupIds,['a@chatroom'],'switching account explicitly acknowledges removed saved groups too');
  assert.equal(nodes.key.value,'','saved password field is cleared');
  interval(); await tick();
  assert.equal(nodes.key.value,'','polling never restores secret text');
  assert.equal(nodes.start.disabled,false,'saving a complete configuration makes explicit start available');
  assert.equal(calls.some(c => c.path === '/api/setup/bridge'),false,'saving never starts the bridge automatically');
  failBridgeStart = true; await fire('start');
  assert.equal(calls.findLast(c => c.path === '/api/setup/bridge').body.instance,'ui-instance');
  assert.match(nodes.notice.textContent,/模拟启动失败/);
  assert.equal(nodes.start.disabled,false,'a failed bridge start leaves controls usable');
  console.log('setup UI simulated flow passed: early edits, poll protection, account isolation, explicit actions, and secret handling.');
})().catch(error => { console.error(error); process.exitCode = 1; });
