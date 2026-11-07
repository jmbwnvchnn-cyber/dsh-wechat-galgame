'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHandler}=require('../src/handler'),{loadState}=require('../src/store');
const root=fs.mkdtempSync(path.join(__dirname,'..','.context-events-'));
let now=Date.parse('2026-11-03T04:00:00Z'),seq=0,claims=0,lastRequest,failClaims=false;
const config={root,groupAllowlist:['g','other'],respondOnlyWhenMentioned:true,randomEventsEnabled:true};
const options={now:()=>now,random:()=>0,
 generateTurn:async request=>{lastRequest=request;return{reply:'说到今晚的合作游戏，我也想听听你们的安排。',delta:0,reason:'聊天',
   event:{title:'今晚的合作局',text:'大家讨论今晚组队时，她问起应该怎样安排。',options:[
     {text:'邀请她一起开荒',reply:'她有些期待地答应了。',delta:2},
     {text:'先问她想玩什么位置',reply:'她觉得自己的想法被认真听见了。',delta:1},
     {text:'建议她先观战',reply:'她有点失落。',delta:-1}]}};},
 generateEventChoices:async request=>{claims++;if(failClaims)throw Error('offline');
   const likes=request.route.profile.facts.map(f=>f.text).join('、');
   return [
     {text:request.route.profile.nickname+'结合'+likes+'提出自己的安排',reply:'她记得你以前说过的喜好。',delta:request.route.profile.nickname==='alice'?3:-2},
     {text:'认真听她谈今晚的合作计划',reply:'她继续分享了计划。',delta:1},
     {text:'先给她一点准备时间',reply:'她点点头。',delta:0}];}
};
let handler=createHandler(config,options);
const event=(text,user='host',group='g',extra={})=>({chat_type:'group',chat_id:group,user_id:user,nickname:user,msg_id:String(++seq),text,at_me:true,is_self:false,...extra});
const send=(text,user,group,extra)=>handler(event(text,user,group,extra));
async function main(){
 await send('/记住 我喜欢草莓','alice');await send('/记住 我喜欢咖啡','bob');
 for(let i=0;i<4;i++)await send('聊聊今晚合作游戏'+i);
 const card=await send('今晚一起组队吧','host','g',{group_context:[
   {chat_id:'g',nickname:'队友',text:'我们想先练习配合。',at:now/1000},
   {chat_id:'other',nickname:'外人',text:'另一个群的秘密。',at:now/1000}]});
 let state=loadState(path.join(root,'data')),active=state.randomEvents.g.active;
 assert.equal(active.version,2);assert.match(card.reply,/合作局/);assert.match(card.reply,/host.*选项|选项.*host/);
 assert.ok(lastRequest.route.eventRequest,'event piggybacks on ordinary response');
 assert.ok(JSON.stringify(lastRequest.route.groupConversation).includes('先练习配合'));
 assert.ok(!JSON.stringify(lastRequest.route.groupConversation).includes('秘密'));
 assert.match((await send('A','alice')).reply,/领取/,'cannot copy a letter before claiming');
 const alice=await send('/事件','alice');assert.match(alice.reply,/草莓/);assert.equal(claims,1);
 assert.match((await send('/事件','bob')).reply,/咖啡/);assert.equal(claims,2);
 assert.equal((await send('/事件','alice')).reply,alice.reply);assert.equal(claims,2,'no reroll on repeated claim');
 state=loadState(path.join(root,'data'));active=state.randomEvents.g.active;
 const a=active.challenges.alice.options.find(o=>o.delta===3),b=active.challenges.bob.options.find(o=>o.delta===-2);
  assert.notDeepEqual(active.challenges.alice.options.map(o=>o.text),active.challenges.bob.options.map(o=>o.text));
 assert.equal((await send('/选择 '+a.label,'alice')).score,3);
 assert.equal((await send('/选择 '+b.label,'bob')).score,-2);
 assert.equal(claims,2,'submission never calls the model again');
 handler=createHandler(config,options);
 assert.match((await send('/选择 '+a.label,'alice')).reply,/已经|已选择/);
 await send('/事件','__proto__');state=loadState(path.join(root,'data'));assert.ok(Object.hasOwn(state.randomEvents.g.active.challenges,'__proto__'));
 failClaims=true;const fallback=await send('/事件','fallback');assert.match(fallback.reply,/合作局/);const before=claims;
 assert.equal((await send('/事件','fallback')).reply,fallback.reply);assert.equal(claims,before,'fallback is also cached');
  now+=1000;await send('/忘记 全部','fallback');
  assert.match((await send('/事件','fallback')).reply,/作废/);assert.equal(claims,before,'forgetting must not allow rerolling the same event');
  await send('现在重新聊聊今晚的合作','alice','g',{group_context:[{chat_id:'g',user_id:'fallback',nickname:'fallback',text:'我喜欢咖啡',at:(now-1000)/1000}]});
  assert.ok(!JSON.stringify(lastRequest.route.groupConversation).includes('我喜欢咖啡'),'forgotten raw context must not be reintroduced');
 now=active.expiresAt;assert.match((await send('/事件','late')).reply,/结束|过期/);assert.equal(claims,before);
 console.log('话题事件验证通过：同群上下文、个人记忆、先领取、字母绑定、缓存/重启、原型ID、降级和到期。');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
