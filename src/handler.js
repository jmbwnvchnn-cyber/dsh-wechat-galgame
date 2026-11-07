'use strict';

const path = require('node:path');
const { shouldRespondToCharacter } = require('./config');
const { loadState } = require('./store');
const { recordMessage, recordFallback, recordCommand, settleTurn, resetRoute, resetGame } = require('./game');
const { loadPersona, savePersona } = require('./persona');
const { generateTurn, generateEventChoices, modelErrorCode, modelFailureReply } = require('./llm');
const memory = require('./memory');
const events = require('./events');

function groupConversation(state, canonical, provided) {
  const reset = item => {
    const cutoff = item.user_id ? memory.own(state.profiles,item.user_id)?.contextResetAt : Math.max(0,...Object.values(state.profiles).map(p=>p.contextResetAt||0));
    return !cutoff || (Number.isFinite(item.at) && item.at * 1000 > cutoff);
  };
  const incoming = Array.isArray(provided) ? provided.filter(item => item && item.chat_id === canonical.groupId && (item.user_id === undefined || typeof item.user_id === 'string') && typeof item.text === 'string' && item.text.trim() && reset(item))
    .slice(-8).map(item => ({nickname:typeof item.nickname === 'string' ? item.nickname.slice(0,60) : '群友',text:item.text.slice(0,300),at:Number.isFinite(item.at) ? item.at : undefined})) : [];
  if (incoming.length) return incoming;
  return Object.values(state.routes).filter(route => route.groupId === canonical.groupId)
    .flatMap(route => route.recentConversation.map(turn => ({user_id:route.senderId,nickname:route.nickname,text:turn.text,at:Date.parse(turn.at)/1000})))
    .filter(item => reset(item) && !memory.stripMention(item.text).startsWith('/')).sort((a,b) => a.at-b.at).slice(-8)
    .map(({nickname,text,at}) => ({nickname,text:text.slice(0,300),at}));
}

function createHandler(config, options = {}) {
  const state = options.state || loadState(path.join(config.root, 'data'));
  const generate = options.generateTurn || generateTurn;
  const generateChoices = options.generateEventChoices || generateEventChoices;
  const clock = options.now || Date.now;
  let queue = Promise.resolve();
  let lastModelFailure = null;

  async function processEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { action: 'ignored' };
    const validId = (value) => (typeof value === 'string' || typeof value === 'number') && String(value).trim().length > 0 && String(value).length <= 200;
    if (event.chat_type !== 'group' || !validId(event.chat_id) || !validId(event.user_id) || !validId(event.msg_id) ||
        !config.groupAllowlist.includes(String(event.chat_id)) || event.is_self !== false ||
        (config.botUserId != null && String(event.user_id) === String(config.botUserId)) ||
        !shouldRespondToCharacter({ isMentioned: event.at_me === true }, config) ||
        typeof event.text !== 'string' || !event.text.trim() || event.text.length > 2000 ||
        (event.nickname != null && (typeof event.nickname !== 'string' || event.nickname.length > 200))) {
      return { action: 'ignored' };
    }
    const canonical = {
      groupId: String(event.chat_id), senderId: String(event.user_id), messageId: String(event.msg_id),
      nickname: event.nickname, text: event.text
    };
    const content = memory.stripMention(canonical.text);
    const command = content.match(/^\/(好感|帮助|记忆|记住|忘记|事件|选择)(?:\s+([\s\S]*))?$/);
    const choiceInput = events.parseChoice(content);
    if (content.startsWith('/') && !command && !choiceInput) return { action: 'ignored' };
    const checked = recordMessage(state, canonical);
    if (checked.duplicate) return { action: 'ignored' };

    if (command?.[1] === '事件' && events.needsClaim(state, canonical.groupId, canonical.senderId, config, clock())) {
      const persona = loadPersona(config.root);
      const route = {...checked.route,stage:memory.stage(checked.route.score),attitude:memory.attitude(checked.route.score),
        profile:{...(memory.own(state.profiles,canonical.senderId)||{senderId:canonical.senderId,facts:[]}),nickname:canonical.nickname||canonical.senderId}};
      let personal;
      try { personal = await generateChoices({config,persona,route,scene:events.current(state,canonical.groupId),now:clock()});lastModelFailure=null; }
      catch (error) { lastModelFailure={code:modelErrorCode(error),at:new Date(clock()).toISOString()}; }
      const now = clock(); let reply;
      const done = recordCommand(state,canonical,next => {
        if (events.needsClaim(next,canonical.groupId,canonical.senderId,config,now)) events.claim(next,canonical.groupId,canonical.senderId,route,personal,now);
        reply = events.view(next,canonical.groupId,config,now,persona.name,canonical.senderId);
      },now);
      return done ? {action:'reply',reply} : {action:'ignored'};
    }

    if (choiceInput) {
      const now = clock();
      const chosen = events.selection(state, canonical.groupId, canonical.senderId, choiceInput.label, config, now);
      if (chosen.error) {
        recordCommand(state, canonical, () => {}, now);
        return {action:'reply', reply:chosen.error};
      }
      const {active, option} = chosen;
      const settled = settleTurn(state, canonical, option.reply, option.delta, '随机事件：' + active.title, {
        config, now, eventChoice:{id:active.id,label:option.label}
      });
      return {action:'reply', reply:events.outcome(canonical.nickname || canonical.senderId, option, settled), score:settled.score, winner:settled.winner};
    }

    if (command) {
      const [, name, raw] = command;
      const arg = (raw || '').trim();
      const now = clock();
      let response = '';
      const done = recordCommand(state, canonical, (next, profile) => {
        if (name === '事件') {
          response = events.view(next, canonical.groupId, config, now, loadPersona(config.root).name, canonical.senderId);
        } else if (name === '记住') {
          if (!arg || arg.length > 200) { response = '用法：/记住 内容'; return; }
          const fact = memory.extractCommand(arg);
          if (!fact) { response = '请用明确的第一人称自述，例如 /记住 我喜欢草莓。'; return; }
          memory.put(profile, fact.key, fact.text, 'command', now, next);
          response = '已记住：' + fact.text;
        } else if (name === '忘记') {
          if (!arg) { response = '用法：/忘记 关键词 或 /忘记 全部'; return; }
          profile.facts = arg === '全部' ? [] : profile.facts.filter((fact) => !fact.key.includes(arg) && !fact.text.includes(arg));
          memory.scrub(next, canonical.senderId, now);
          response = '已处理遗忘请求。';
        } else if (name === '记忆') {
          response = profile.facts.length ? '你的记忆：' + profile.facts.map((fact) => fact.text).join('；') : '还没有记住你的事实。';
        } else if (name === '帮助') {
          response = '命令：/好感、/事件（领取个人选项）、/选择 A（或 B/C）、/帮助、/记忆、/记住 内容、/忘记 关键词或全部。事件有效 10 分钟，每人各选一次；不能直接使用别人的字母。';
        } else {
          const limits = memory.scoringState(next, canonical.senderId, config, now);
          const winner = next.winner ? (next.winner.routeKey === checked.routeKey ? '你已攻略成功。' : '已有其他路线攻略成功，分数冻结。') : '尚无胜者。';
          response = `当前好感 ${checked.route.score}，阶段：${memory.stage(checked.route.score)}。今日剩余正向加分 ${limits.remaining}，冷却剩余 ${limits.cooldownRemainingSeconds} 秒。${winner}`;
        }
      }, now);
      return done ? { action: 'reply', reply: response } : { action: 'ignored' };
    }

    let turn, persona, plan, context, player;
    try {
      persona = loadPersona(config.root);
      const groupMembers = Object.values(state.routes).filter((route) => route.groupId === canonical.groupId)
        .map((route) => ({ senderId: route.senderId, nickname: route.senderId === canonical.senderId ? (canonical.nickname || canonical.senderId) : route.nickname }));
      if (!groupMembers.some((member) => member.senderId === canonical.senderId)) {
        groupMembers.push({ senderId: canonical.senderId, nickname: canonical.nickname || canonical.senderId });
      }
      const originalProfile = memory.own(state.profiles, canonical.senderId) || { senderId: canonical.senderId, facts: [] };
      const requestTime = clock();
      context = groupConversation(state,canonical,event.group_context);
      plan = memory.normalize(canonical.text).length >= 2 ? events.planTurn(state,canonical.groupId,config,requestTime,options.random) : null;
      const prospective = memory.preview(originalProfile, memory.extract(canonical.text), requestTime);
      if (prospective.corrected) context = [];
      const route = {
        ...checked.route,
        recentConversation: prospective.corrected ? [] : checked.route.recentConversation,
        groupRoster: { total: groupMembers.length, members: groupMembers.slice(-50) },
        stage: memory.stage(checked.route.score),
        attitude: memory.attitude(checked.route.score),
        groupConversation: context,
        eventRequest: Boolean(plan?.publish),
        profile: { ...prospective.profile, nickname: canonical.nickname || canonical.senderId },
        winnerStatus: state.winner ? { locked: true, isCurrentPlayer: state.winner.routeKey === checked.routeKey } : { locked: false }
      };
      player = route;
      turn = await generate({ config, persona, route, message: canonical.text, now: requestTime });
      if (!turn || typeof turn.reply !== 'string' || !turn.reply.trim() || turn.reply.length > 1000 ||
          typeof turn.delta !== 'number' || !Number.isFinite(turn.delta) || typeof turn.reason !== 'string' || turn.reason.length > 200) {
        throw new Error('Invalid model output');
      }
      lastModelFailure = null;
    } catch (error) {
      lastModelFailure = {code:modelErrorCode(error),at:new Date(clock()).toISOString()};
      recordFallback(state, canonical, clock());
      return { action: 'reply', reply: modelFailureReply(error) };
    }
    let published;
    const now = clock();
    const settled = settleTurn(state, canonical, turn.reply, turn.delta, turn.reason, { config, now,
      mutateState: next => { published = events.commitPlan(next,canonical.groupId,plan,{proposal:turn.event,context:[...context,{nickname:canonical.nickname||canonical.senderId,text:content.slice(0,300),at:now/1000}].slice(-8),player,now,name:persona.name}); }
    });
    if (settled.duplicate) return { action: 'ignored' };
    return {
      action: 'reply',
      reply: turn.reply + (published ? '\n\n' + events.card(published, persona.name, canonical.senderId) : '') + (settled.winnerLocked ? `\n\n恭喜 ${settled.winner.nickname} 攻略成功！` : ''),
      score: settled.score, winner: settled.winner
    };
  }
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function handleInbound(event) { return enqueue(() => processEvent(event)); }
  handleInbound.status = () => enqueue(() => {
    const routes = Object.values(state.routes).map(({ processedMessageIds, ...route }) => ({
      ...route, stage: memory.stage(route.score), scoringState: memory.scoringState(state, route.senderId, config, clock())
    }));
    return { profiles: Object.values(state.profiles), persona: loadPersona(config.root), groups: [...new Set(routes.map((route) => route.groupId))], routes, winner: state.winner, recentEvents: state.recentEvents, modelFailure:lastModelFailure };
  });
  handleInbound.manageMemory = (data) => enqueue(() => memory.manage(state, data, clock()));
  handleInbound.savePersona = (persona) => enqueue(() => savePersona(config.root, persona));
  handleInbound.resetRoute = (groupId, senderId) => enqueue(() => resetRoute(state, groupId, senderId));
  handleInbound.resetGame = () => enqueue(() => resetGame(state));
  handleInbound.updateConfig = (operation) => enqueue(operation);
  return handleInbound;
}
module.exports = { createHandler };
