'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHandler}=require('../src/handler');
const {loadState,saveState}=require('../src/store');
const {settleTurn}=require('../src/game');
const roots=[];
function harness({random=()=>0,enabled=true,cap=15}={}) {
  const root=fs.mkdtempSync(path.join(__dirname,'..','.random-events-'));roots.push(root);
  let state=loadState(path.join(root,'data'));
  const config={root,groupAllowlist:['g','g2'],respondOnlyWhenMentioned:true,randomEventsEnabled:enabled,dailyPositiveCap:cap};
  let now=Date.parse('2026-11-03T02:00:00Z'),seq=0,calls=0;
  const options={state,now:()=>now,random,generateTurn:async()=>{calls++;return{reply:'普通回复',delta:0,reason:'普通聊天'};}};
  let handler=createHandler(config,options);
  const event=(text,user='host',group='g')=>({chat_type:'group',chat_id:group,user_id:user,nickname:user,msg_id:String(++seq),text,at_me:true,is_self:false});
  return {root,get state(){return state;},config,event,get now(){return now;},set now(v){now=v;},get calls(){return calls;},
    send:(text,user,group)=>handler(event(text,user,group)),handle:e=>handler(e),get handler(){return handler;},
    active:group=>(state.randomEvents||{})[group||'g']?.active,
    score:(user,group='g')=>state.routes[JSON.stringify([group,user])]?.score||0,
    legacyScene(group='g'){
      const a=state.randomEvents?.[group]?.active;if(a?.version!==2)return;
      // Pin the existing pre-upgrade save shape to keep these lifecycle,
      // score-limit and victory regressions as explicit legacy-compatibility proof.
      delete a.version;delete a.challenges;delete a.context;
      a.options=[{label:'A',text:'旧版正向选项',reply:'旧版正向回应',delta:3},{label:'B',text:'旧版中性选项',reply:'旧版中性回应',delta:0},{label:'C',text:'旧版负向选项',reply:'旧版负向回应',delta:-2}];saveState(state,state);
    },
    async trigger(group='g',count=5){let r;for(let i=0;i<count;i++)r=await this.send('今天第'+seq+'次聊聊新话题','host',group);this.legacyScene(group);return r;},
    reload(){state=loadState(path.join(root,'data'));handler=createHandler(config,{...options,state});return handler;}
  };
}
async function main(){
  const h=harness();
  for(let i=0;i<4;i++)await h.send('今天聊个新话题'+i);
  assert.equal(h.active(),null,'no trigger before five ordinary turns');
  const card=await h.send('一起去看星星');
  assert.match(card.reply,/随机事件/);assert.match(card.reply,/10 分钟/);
  h.legacyScene();
  const active=h.active();assert.equal(active.expiresAt-h.now,600000);
  assert.deepEqual(new Set(active.options.map(o=>o.label)),new Set(['A','B','C']));
  const positive=active.options.find(o=>o.delta>0);
  const modelCalls=h.calls;
  const choice=h.event('/选择 '+positive.label,'alice');
  assert.match((await h.handle(choice)).reply,/好感.*\/100/);
  assert.equal(h.score('alice'),positive.delta);
  assert.equal((await h.handle(choice)).action,'ignored','same message id is durable');
  assert.match((await h.send('选'+positive.label,'alice')).reply,/已经|已选择/);
  assert.equal(h.score('alice'),positive.delta,'new message cannot replay choice');
  await h.send(positive.label,'bob');assert.equal(h.score('bob'),positive.delta,'each player gets their own choice');
  assert.equal(h.calls,modelCalls,'choice and repeat never call AI');
  h.reload();
  assert.match((await h.send('/选择 '+positive.label,'alice')).reply,/已经|已选择/,'participation survives restart before expiry');
  h.config.randomEventsEnabled=false;
  assert.match((await h.send('/选择 '+positive.label,'disabled')).reply,/关闭/);
  h.config.randomEventsEnabled=true;
  assert.equal(h.active().expiresAt,active.expiresAt,'toggling events cannot extend expiry');
  assert.match((await h.send('/事件')).reply,/随机事件/);
  assert.match((await h.send('/选择 D','bad')).reply,/选项|A.*B.*C/);
  assert.match((await h.send('/选择 A','outsider','g2')).reply,/没有|暂无/);
  h.now=active.expiresAt-1;await h.send('/选择 '+positive.label,'last');assert.equal(h.score('last'),positive.delta);
  h.now=active.expiresAt;assert.match((await h.send('/选择 '+positive.label,'late')).reply,/结束|过期|超时/);
  assert.equal(h.score('late'),0);
  const reloaded=h.reload();
  assert.match((await reloaded(h.event('/事件'))).reply,/结束|过期/,'restart cannot extend expiry');

  const guaranteed=harness({random:()=>0.99});
  await guaranteed.trigger('g',11);assert.equal(guaranteed.active(),null);
  await guaranteed.trigger('g',1);assert.ok(guaranteed.active(),'twelfth eligible turn guarantees an event');
  const off=harness({enabled:false});await off.trigger('g',15);assert.equal(off.active(),undefined);
  assert.match((await off.send('/事件')).reply,/关闭/);

  const budget=harness();await budget.trigger();
  const first=budget.active().id;
  await budget.trigger('g',12);assert.equal(budget.active().id,first,'active event prevents replacement');
  budget.now+=11*60000;await budget.trigger('g',12);assert.equal(budget.active().id,first,'thirty-minute cooldown persists');
  budget.now+=20*60000;await budget.trigger();assert.notEqual(budget.active().id,first);
  budget.now+=31*60000;await budget.trigger();const third=budget.active().id;
  budget.now+=31*60000;await budget.trigger('g',15);assert.equal(budget.active().id,third,'three events per group per day');
  budget.now+=24*3600000;await budget.trigger();assert.notEqual(budget.active().id,third,'new China day resets trigger budget');
  await budget.trigger('g2');assert.ok(budget.active('g2'),'group budgets are independent');

  const scoring=harness();await scoring.trigger();const option=scoring.active().options.find(o=>o.delta>0);
  const topics=['清晨阳光照亮窗台','海边浪花轻拍沙滩','森林小鸟唱起歌曲'];
  const seed=(user,delta,id)=>settleTurn(scoring.state,{groupId:'g',senderId:user,nickname:user,messageId:id,text:id.startsWith('cap')?topics[Number(id.slice(3))]:'一次有效自述'+id},'收到',delta,'seed',{config:scoring.config,now:scoring.now});
  seed('warm',5,'warmup');await scoring.send('/选择 '+option.label,'warm');
  assert.equal(scoring.score('warm'),5+option.delta,'ordinary cooldown does not suppress event choices');
  for(let i=0;i<3;i++){scoring.now+=121000;seed('capped',5,'cap'+i);}
  await scoring.send('/选择 '+option.label,'capped');assert.equal(scoring.score('capped'),15,'events obey daily cap');
  seed('negative',5,'negseed');const negative=scoring.active().options.find(o=>o.delta<0);
  await scoring.send('/选择 '+negative.label,'negative');assert.equal(scoring.score('negative'),5+negative.delta);
  await scoring.handler.resetRoute('g','warm');assert.match((await scoring.send('/选择 '+option.label,'warm')).reply,/已经|已选择/);

  const atomic=harness();await atomic.trigger();const plus=atomic.active().options.find(o=>o.delta>0), attempt=atomic.event('/选择 '+plus.label,'atomic');
  const rename=fs.renameSync;fs.renameSync=()=>{throw Error('synthetic disk error');};
  try{await assert.rejects(atomic.handle(attempt));}finally{fs.renameSync=rename;}
  assert.equal(atomic.score('atomic'),0);assert.equal(Object.hasOwn(atomic.active().participants,'atomic'),false);
  await atomic.handle(attempt);assert.equal(atomic.score('atomic'),plus.delta,'failed transaction can safely retry');
  const concurrent=await Promise.all([atomic.send('/选择 '+plus.label,'race'),atomic.send('/选择 '+plus.label,'race')]);
  assert.equal(atomic.score('race'),plus.delta);assert.ok(concurrent.some(r=>/已经|已选择/.test(r.reply)));
  await atomic.send('/选择 '+plus.label,'__proto__');assert.equal(Object.hasOwn(atomic.active().participants,'__proto__'),true);
  const count=atomic.state.randomEvents.g.count;await atomic.handler.resetGame();
  assert.equal(atomic.active(),null);assert.equal(atomic.state.randomEvents.g.count,count,'reset preserves trigger budget');
  await atomic.trigger('g',12);assert.equal(atomic.active(),null,'reset cannot bypass cooldown');

  const victory=harness({cap:1000});await victory.trigger();
  for(const user of ['winner','runner'])for(let i=0;i<20;i++)settleTurn(victory.state,{groupId:'g',senderId:user,nickname:user,messageId:user+i,text:'有效游戏话题'+user+i},'收到',i===19?4:5,'seed',{config:{...victory.config,positiveCooldownSeconds:0,repeatWindowHours:0},now:victory.now+i});
  const winOption=victory.active().options.find(o=>o.delta>0);
  assert.match((await victory.send('/选择 '+winOption.label,'winner')).reply,/攻略成功/);
  await victory.send('/选择 '+winOption.label,'runner');assert.equal(victory.score('runner'),99);assert.equal(victory.state.winner.senderId,'winner');

  const corrupt=fs.mkdtempSync(path.join(__dirname,'..','.random-events-'));roots.push(corrupt);
  const corruptFile=path.join(corrupt,'game-state.json');const damaged=JSON.parse(JSON.stringify(victory.state));
  damaged.randomEvents.g.active.options[0].delta=999;const original=JSON.stringify(damaged);fs.writeFileSync(corruptFile,original);
  const report=console.error;console.error=()=>{};
  try{assert.throws(()=>loadState(corrupt),/随机事件/);}finally{console.error=report;}
  assert.equal(fs.readFileSync(corruptFile,'utf8'),original,'invalid event saves are preserved, not reset');
  console.log('旧事件兼容回归通过：触发/保底/冷却/日限/跨群、10分钟边界、每人一次、重启、正负分、日上限、并发、原子失败、重置和唯一胜者。');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
