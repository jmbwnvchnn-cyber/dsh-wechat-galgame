'use strict';
const {randomUUID,createHash}=require('node:crypto');
const memory=require('./memory'),format=require('./event-format');
const DURATION=10*60*1000,COOLDOWN=30*60*1000;
function enabled(config){return config.randomEventsEnabled!==false;}
function current(state,group){return memory.own(state.randomEvents||{},group)?.active||null;}
function memoryChanged(state,active,user){return active?.version===2&&(memory.own(state.profiles,user)?.contextResetAt||0)>active.createdAt;}
function planTurn(state,group,config,now,random=Math.random){
  if(!enabled(config)||state.winner)return null;
  const previous=memory.own(state.randomEvents||{},group);
  const today=memory.day(now),record=previous?JSON.parse(JSON.stringify(previous)):{day:today,count:0,turns:0,lastTriggeredAt:null,active:null};
  if(record.day!==today){record.day=today;record.count=0;record.turns=0;}
  if(record.active&&now<record.active.expiresAt)return {record,publish:false};
  if(record.count>=3||(record.lastTriggeredAt!==null&&now-record.lastTriggeredAt<COOLDOWN))return {record,publish:false};
  record.turns=Math.min(12,record.turns+1);
  return {record,publish:record.turns>=5&&(record.turns>=12||random()<0.2)};
}
function fallbackOptions(scene,route){
  const close=route.score>=50,distant=route.score<0;
  const fact=(route.profile?.facts||[]).at(-1)?.text;
  const familiar=fact?'，也想起你说过的“'+fact.slice(0,60)+'”':'';
  return [
    {text:'主动邀请她一起推进刚才的话题',reply:close?'她笑着接受了你的邀请'+familiar+'。':distant?'她觉得突然靠近有点冒失，暂时保持了距离。':'她愿意先听听你的具体想法。',delta:close?3:distant?-1:1},
    {text:'先问她在这件事上最在意什么',reply:'她察觉你愿意认真倾听，慢慢说出了自己的想法'+familiar+'。',delta:2},
    {text:'给她一点准备时间，稍后再一起决定',reply:close?'她本来期待你继续陪她，略有些失落。':distant?'她松了一口气，感谢你留给她空间。':'她点点头，约好稍后继续讨论。',delta:close?-1:distant?1:0}
  ];
}
function makeChallenge(active,user,route,proposed,now){
  active.challenges ||= {};
  const existing=memory.own(active.challenges,user);if(existing)return existing;
  const options=format.choices(proposed)||fallbackOptions(active,route);
  const bytes=createHash('sha256').update(active.id+'\0'+user).digest();
  for(let i=options.length-1;i>0;i--){const j=bytes[i]%(i+1);[options[i],options[j]]=[options[j],options[i]];}
  return memory.setOwn(active.challenges,user,{nickname:route.profile?.nickname||user,scoreAtClaim:route.score,issuedAt:now,
    options:options.map((o,i)=>({label:'ABC'[i],...o}))});
}
function commitPlan(state,group,plan,{proposal,context,player,now,name}){
  if(!plan||state.winner)return null;
  const record=plan.record;
  let active=null;
  if(plan.publish){
    const draft=format.draft(proposal);
    const topic=(context.at(-1)?.text||'刚才的话题').replace(/[\r\n]/g,' ').slice(0,90);
    active={version:2,id:randomUUID(),title:draft?.title||'话题里的一个小插曲',
      text:draft?.text||`聊到“${topic}”时，${name||'她'}停顿了一下，想听听大家会怎样继续这件事。`,
      createdAt:now,expiresAt:now+DURATION,participants:{},challenges:{},context,source:draft?'model':'fallback'};
    const challenge=makeChallenge(active,player.senderId,player,draft?.options,now);
    active.options=challenge.options; // Keep old saved-event readers compatible.
    record.active=active;record.count++;record.turns=0;record.lastTriggeredAt=now;
  }
  state.randomEvents ||= {};memory.setOwn(state.randomEvents,group,record);return active;
}
function claim(state,group,user,route,options,now){
  const active=current(state,group);
  if(!active||active.version!==2||now>=active.expiresAt)throw Error('事件已过期');
  return makeChallenge(active,user,route,options,now);
}
function needsClaim(state,group,user,config,now){
  const active=current(state,group);
  return Boolean(enabled(config)&&!state.winner&&active?.version===2&&now<active.expiresAt&&!memoryChanged(state,active,user)&&!memory.own(active.challenges,user));
}
function card(active,name='她',user){
  const deadline=new Date(active.expiresAt+8*3600000).toISOString().slice(11,19);
  const challenge=active.version===2?memory.own(active.challenges,user):null;
  const options=active.version===2?challenge?.options:active.options;
  const heading=challenge?`\n【${challenge.nickname} 的个人选项，仅本人有效】`:'';
  const choices=options?'\n\n'+options.map(o=>`${o.label}. ${o.text}`).join('\n'):'';
  const instruction=active.version===2?`\n其他群友先 @${name} /事件 领取自己的选项，不能直接套用别人的字母。`:'';
  return `【随机事件 · ${active.title}】\n${active.text}${heading}${choices}\n\n每位群友可在 10 分钟内各选一次。\n@${name} /选择 A（或 B、C，也可发“选A”）${instruction}\n截止 ${deadline}（北京时间），超时不结算。`;
}
function view(state,group,config,now,name,user){
  if(!enabled(config))return '随机事件已关闭。';
  if(state.winner)return '本局已有玩家攻略成功，不再开启新的随机事件。';
  const active=current(state,group);
  if(!active)return '当前没有进行中的随机事件，继续和我聊天，可能会遇到新的故事。';
  if(now>=active.expiresAt)return '这个随机事件已经结束（超过 10 分钟）。等待下次事件吧。';
  if(memoryChanged(state,active,user))return '你的记忆刚刚更正或遗忘，本次个人选项已作废；下次事件会使用更新后的资料。';
  return card(active,name,user)+`\n剩余 ${Math.ceil((active.expiresAt-now)/1000)} 秒。`;
}
function parseChoice(text){
  const normalized=text.normalize('NFKC').trim();
  const explicit=normalized.match(/^(?:\/选择|选择|选)\s*(.*?)$/);
  if(!explicit&&!/^[ABC123]$/i.test(normalized))return null;
  const input=(explicit?explicit[1]:normalized).toUpperCase();return {label:/^[123]$/.test(input)?'ABC'[Number(input)-1]:input};
}
function selection(state,group,user,label,config,now){
  if(!enabled(config))return {error:'随机事件已关闭。'};
  if(state.winner)return {error:'本局已有玩家攻略成功，好感度已冻结。'};
  const active=current(state,group);
  if(!active)return {error:'当前没有可选择的随机事件。'};
  if(now>=active.expiresAt)return {error:'这个随机事件已经结束，超时不再结算好感。'};
  if(memoryChanged(state,active,user))return {error:'你的记忆已更正或遗忘，本次个人选项已作废，不能通过重新领取刷新选项。'};
  const previous=memory.own(active.participants,user);
  if(previous)return {error:`你在本次事件中已经选择 ${previous.label}，不能重复结算或更改选项。`};
  const challenge=active.version===2?memory.own(active.challenges,user):null;
  if(active.version===2&&!challenge)return {error:'请先 @我 /事件 领取你自己的个人选项，再作选择；别人的字母不适用于你。'};
  const option=(challenge?.options||active.options).find(o=>o.label===label);
  if(!option)return {error:'请给出有效选项：/选择 A、/选择 B 或 /选择 C。'};
  return {active,option};
}
function outcome(nickname,option,settled){
  const change=settled.delta===0?'无变化':(settled.delta>0?'+':'')+settled.delta;
  const limit=settled.delta!==option.delta?'\n已按今日加分上限和 -100～100 分范围结算。':'';
  return `「${nickname}」选择了 ${option.label}。${option.reply}\n♡ 好感度 ${settled.score}/100（${change}）· ${memory.stage(settled.score)}${limit}`+(settled.winnerLocked?`\n\n恭喜 ${settled.winner.nickname} 攻略成功！`:'');
}
module.exports={planTurn,commitPlan,current,needsClaim,claim,card,view,parseChoice,selection,outcome};
