'use strict';
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.style = {}; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { this.children.push(...nodes); if (this.tag === 'select' && !this.value && nodes[0]) this.value = nodes[0].value; }
  replaceChildren(...nodes) { this.children = []; if (this.tag === 'select') this.value = ''; this.append(...nodes); }
  querySelectorAll() { return []; }
  reset() { for (const v of Object.values(this.elements || {})) v.value = ''; }
  focus() {} showModal() {} close() {}
}
const nodes = Object.fromEntries(['notice','connection','persona-form','fact-form','persona-state','profile-select','profile-detail','clear-memory','player-count','group-count','winner-name','winner-detail','routes','event-list','refresh','reset-dialog','confirmation','open-reset','confirm-reset'].map(id => [id, new Node(id === 'profile-select' ? 'select' : 'div')]));
nodes['persona-form'].elements = {name:new Node(),aliases:new Node(),prompt:new Node()}; nodes['fact-form'].elements = {key:new Node(),text:new Node()};
const document = {querySelector: s => nodes[s.slice(1)], querySelectorAll: () => [], createElement: tag => new Node(tag), addEventListener() {}, hidden:false};
let status = {persona:{name:'原角色',aliases:[],prompt:'原设定'},routes:[],groups:[],winner:null,recentEvents:[],profiles:[{senderId:'u',nickname:'甲',nicknameHistory:[],firstSeenAt:1,lastSeenAt:2,facts:[{key:'k',text:'<img onerror=alert(1)>',source:'self',updatedAt:3}]}]};
let pending = [], interval;
const context = {document, window:{addEventListener(type, fn) { if (type === 'beforeunload') this.beforeunload = fn; }}, fetch: () => new Promise(resolve => pending.push(resolve)), setInterval: fn => { interval = fn; }, confirm:()=>true, console, Date};
const respond = (i, value) => pending[i]({ok:true,json:async()=>value});
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  vm.runInNewContext(fs.readFileSync('web/app.js','utf8'), context);
  nodes['persona-form'].elements.name.value = '加载前输入'; nodes['persona-form'].listeners.input();
  status.modelFailure={code:'http_503'};
  respond(0,status); await tick();
  assert.match(nodes.connection.textContent,/503/);
  status={...status,modelFailure:null,routes:[{groupId:'g',senderId:'u',nickname:'甲',score:-25,stage:'戒备',recentConversation:[]}]};
  interval();respond(1,status);await tick();
  const negativeBar=nodes.routes.children[0].children[1];
  assert.match(nodes.connection.textContent,/连接正常/);
  assert.match(negativeBar.title,/-100/);assert.equal(negativeBar.children[1].style.width,'12.5%');assert.equal(negativeBar.children[1].style.left,'37.5%');
  assert.equal(nodes['persona-form'].elements.name.value, '加载前输入');
  nodes['persona-form'].elements.name.value = '原角色'; nodes['persona-form'].elements.prompt.value = '原设定'; nodes['persona-form'].listeners.input();
  interval(); respond(2,status); await tick();
  assert.equal(nodes['persona-form'].elements.name.value,'原角色');
  assert.equal(nodes['profile-detail'].children[1].children[0].children[0].textContent,'<img onerror=alert(1)>');
  nodes['persona-form'].elements.name.value = '未保存'; nodes['persona-form'].listeners.input();
  let prevented = false; context.window.beforeunload({preventDefault(){prevented=true;}}); assert.ok(prevented);
  interval(); interval(); respond(4,{...status,persona:{...status.persona,name:'较新'}}); await tick(); respond(3,{...status,persona:{...status.persona,name:'过期'}}); await tick();
  assert.equal(nodes['persona-form'].elements.name.value,'未保存');
  assert.match(nodes['persona-state'].textContent,/未保存/);
  nodes['persona-form'].elements.name.value = '已保存的新角色';
  nodes['persona-form'].listeners.input();
  nodes['persona-form'].listeners.submit({preventDefault(){}});
  respond(5,{}); await tick();
  pending[6]({ok:false,status:503,json:async()=>({error:'离线'})}); await tick();
  assert.equal(nodes['persona-form'].elements.name.value,'已保存的新角色');
  assert.match(nodes.notice.textContent,/已保存.*刷新失败/);
  console.log('UI 回归通过：安全文本、未保存保护、离页提醒与乱序刷新。');
})().catch(error => {console.error(error); process.exitCode=1;});
