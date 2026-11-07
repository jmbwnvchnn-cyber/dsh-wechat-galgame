'use strict';

const { persistedState, replaceState, saveState } = require('./store');
const memory = require('./memory');

const MAX_DELTA = 5;
const MIN_SCORE = -100;
const MAX_SCORE = 100;
const RECENT_CONVERSATIONS_LIMIT = 20;
const RECENT_EVENTS_LIMIT = 100;

function gameError(message) {
  return new Error(`游戏状态错误: ${message}`);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function requiredId(value, name) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw gameError(`${name} 必须是非空字符串或数字。`);
  }
  return String(value);
}

function optionalText(value, fallback = '') {
  return typeof value === 'string' ? value.slice(0, 2000) : fallback;
}

function normalizeEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw gameError('event 必须是对象。');
  }
  const groupId = requiredId(event.groupId ?? event.chat_id, 'groupId');
  const senderId = requiredId(event.senderId ?? event.user_id, 'senderId');
  const messageId = requiredId(event.messageId ?? event.msgId ?? event.msg_id, 'messageId');
  return {
    groupId,
    senderId,
    messageId,
    nickname: optionalText(event.nickname, senderId) || senderId,
    text: optionalText(event.text ?? event.content)
  };
}

/** JSON array encoding makes (groupId, senderId) keys unambiguous. */
function routeKey(groupId, senderId) {
  return JSON.stringify([groupId, senderId]);
}

function newRoute(event) {
  return {
    groupId: event.groupId,
    senderId: event.senderId,
    nickname: event.nickname,
    score: 0,
    recentConversation: [],
    processedMessageIds: []
  };
}

function routeForRecord(state, event) {
  const key = routeKey(event.groupId, event.senderId);
  return { key, route: state.routes[key] || newRoute(event) };
}

/**
 * Checks a message before model work without exposing a mutable live route.
 * Settlement or fallback marks the ID processed after its snapshot has been saved.
 */
function recordMessage(state, event) {
  const normalized = normalizeEvent(event);
  const { key, route } = routeForRecord(state, normalized);
  return {
    duplicate: route.processedMessageIds.includes(normalized.messageId),
    route: JSON.parse(JSON.stringify(route)),
    routeKey: key,
    previousScore: route.score
  };
}

function cloneForSettlement(state) {
  return JSON.parse(JSON.stringify(persistedState(state)));
}

function recordFallback(state, event, now = Date.now()) {
  const checked = recordMessage(state, event);
  if (checked.duplicate) return { duplicate: true };
  const normalized = normalizeEvent(event);
  const next = cloneForSettlement(state);
  const route = next.routes[checked.routeKey] || newRoute(normalized);
  next.routes[checked.routeKey] = route;
  route.processedMessageIds.push(normalized.messageId);
  const profile = memory.touch(next, normalized, now);
  const fact = memory.extract(normalized.text);
  if (fact) memory.put(profile, fact.key, fact.text, 'self', now, next);
  saveState(state, next);
  replaceState(state, next);
  return { duplicate: false };
}

function finiteDelta(delta) {
  const numeric = typeof delta === 'number' ? delta : Number(delta);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function appendLimited(values, item, limit) {
  values.push(item);
  if (values.length > limit) values.splice(0, values.length - limit);
}

/**
 * Applies and persists one turn synchronously. Synchronous snapshots plus the
 * single-process contract serialize winner selection without a model ever
 * receiving authority to mutate state directly.
 */
function settleTurn(state, event, reply, delta, reason, options = {}) {
  const now = options.now ?? Date.now();
  const config = options.config || {};
  const checked = recordMessage(state, event);
  const normalized = normalizeEvent(event);
  if (checked.duplicate) {
    return {
      duplicate: true,
      route: checked.route,
      previousScore: checked.previousScore,
      score: checked.previousScore,
      delta: 0,
      winner: state.winner,
      winnerLocked: false,
      frozen: Boolean(state.winner)
    };
  }

  const next = cloneForSettlement(state);
  const nextRoute = next.routes[checked.routeKey] || newRoute(normalized);
  next.routes[checked.routeKey] = nextRoute;
  const previousScore = nextRoute.score;
  const suggestedDelta = clamp(finiteDelta(delta), -MAX_DELTA, MAX_DELTA);
  const frozen = Boolean(next.winner);
  const profile = memory.touch(next, normalized, now);
  const fact = memory.extract(normalized.text);
  if (fact) memory.put(profile, fact.key, fact.text, 'self', now, next);
  const limits = memory.scoringState(next, normalized.senderId, config, now);
  const eventChoice = options.eventChoice;
  let choiceEvent;
  if (eventChoice) {
    choiceEvent = memory.own(next.randomEvents || {}, normalized.groupId)?.active;
    const personal = choiceEvent?.version === 2 ? memory.own(choiceEvent.challenges || {}, normalized.senderId) : null;
    const choice = (choiceEvent?.version === 2 ? personal?.options : choiceEvent?.options)?.find(o => o.label === eventChoice.label);
    if (!choiceEvent || choiceEvent.id !== eventChoice.id || now >= choiceEvent.expiresAt ||
        memory.own(choiceEvent.participants, normalized.senderId) || !choice || choice.delta !== suggestedDelta) throw gameError('事件已失效或选择无效。');
  }
  const scoreData = memory.own(next.scoring, normalized.senderId) || memory.setOwn(next.scoring, normalized.senderId, { day: limits.day, earned: 0, lastPositiveAt: null, messages: [] });
  if (scoreData.day !== limits.day) { scoreData.day = limits.day; scoreData.earned = 0; }
  const windowMs = (config.repeatWindowHours ?? 24) * 3600000;
  scoreData.messages = (scoreData.messages || []).filter(x => x.at > now - windowMs);
  const normalizedText = memory.normalize(eventChoice ? '随机事件' + choiceEvent.id : normalized.text);
  const fingerprint = memory.fingerprint(normalizedText);
  let allowed = suggestedDelta;
  let policy = '';
  if (suggestedDelta > 0) {
    if ([...normalizedText].length < 2) { allowed = 0; policy = '内容不足两个有效字符，正向加分已拦截'; }
    else if (scoreData.messages.some(x => memory.similarFingerprint(x.fingerprint || memory.fingerprint(x.text || ''), fingerprint))) { allowed = 0; policy = `近${config.repeatWindowHours ?? 24}小时内容重复，正向加分已拦截`; }
    else if (!eventChoice && limits.cooldownRemainingSeconds > 0) { allowed = 0; policy = '正向加分冷却中'; }
    else if (limits.remaining === 0) { allowed = 0; policy = '今日正向加分已达上限'; }
    else if (allowed > limits.remaining) { allowed = limits.remaining; policy = '正向加分受今日上限限制'; }
  }
  if (normalizedText) scoreData.messages.push({fingerprint, at: now});
  nextRoute.score = frozen ? previousScore : clamp(previousScore + allowed, MIN_SCORE, MAX_SCORE);
  if (frozen) policy = '胜者已锁定，分数冻结';
  else if (nextRoute.score - previousScore !== allowed && !policy) policy = '分数受 -100 到 100 的边界限制';
  reason = [reason, policy].filter(Boolean).join('；');
  if (nextRoute.score > previousScore) { scoreData.earned += nextRoute.score - previousScore; scoreData.lastPositiveAt = now; }
  const appliedDelta = nextRoute.score - previousScore;
  nextRoute.nickname = normalized.nickname;

  let winnerLocked = false;
  if (!next.winner && nextRoute.score === MAX_SCORE) {
    next.winner = {
      routeKey: checked.routeKey,
      groupId: normalized.groupId,
      senderId: normalized.senderId,
      nickname: normalized.nickname,
      score: MAX_SCORE,
      messageId: normalized.messageId,
      lockedAt: new Date(now).toISOString()
    };
    winnerLocked = true;
  }
  if (eventChoice) memory.setOwn(choiceEvent.participants, normalized.senderId, {
    label: eventChoice.label, messageId: normalized.messageId, at: now
  });

  // This is the durable idempotency record: IDs must survive for the game lifetime.
  nextRoute.processedMessageIds.push(normalized.messageId);
  appendLimited(nextRoute.recentConversation, {
    messageId: normalized.messageId,
    text: normalized.text,
    reply: optionalText(reply),
    delta: appliedDelta,
    reason: optionalText(reason),
    at: new Date(now).toISOString()
  }, RECENT_CONVERSATIONS_LIMIT);
  appendLimited(next.recentEvents, {
    type: winnerLocked ? 'winner_locked' : 'turn_settled',
    groupId: normalized.groupId,
    senderId: normalized.senderId,
    nickname: normalized.nickname,
    messageId: normalized.messageId,
    previousScore,
    score: nextRoute.score,
    suggestedDelta,
    appliedDelta,
    reason: optionalText(reason),
    at: new Date(now).toISOString()
  }, RECENT_EVENTS_LIMIT);

  // No in-memory score/history/processed-ID change is committed until save succeeds.
  if (options.mutateState) options.mutateState(next);
  saveState(state, next);
  replaceState(state, next);
  return {
    duplicate: false,
    route: state.routes[checked.routeKey],
    previousScore,
    score: nextRoute.score,
    delta: appliedDelta,
    winner: state.winner,
    winnerLocked,
    frozen
  };
}

function recordCommand(state, event, mutate, now) {
  const checked = recordMessage(state, event); if (checked.duplicate) return false;
  const e = normalizeEvent(event), next = cloneForSettlement(state);
  const route = next.routes[checked.routeKey] || newRoute(e); next.routes[checked.routeKey] = route;
  route.nickname = e.nickname; route.processedMessageIds.push(e.messageId);
  const profile = memory.touch(next, e, now); mutate(next, profile);
  saveState(state, next); replaceState(state, next); return true;
}

/** Reset one route before a winner is locked, for later local-admin use. */
function resetRoute(state, groupId, senderId) {
  const normalizedGroupId = requiredId(groupId, 'groupId');
  const normalizedSenderId = requiredId(senderId, 'senderId');
  const key = routeKey(normalizedGroupId, normalizedSenderId);
  if (state.winner) {
    throw gameError('胜者已锁定，好感度已冻结；请通过未来的整局重置功能解除全局胜者锁。');
  }
  if (!state.routes[key]) return state;

  const next = cloneForSettlement(state);
  const existing = next.routes[key];
  next.routes[key] = {
    groupId: normalizedGroupId,
    senderId: normalizedSenderId,
    nickname: existing.nickname || normalizedSenderId,
    score: 0,
    recentConversation: [],
    // A route reset does not start a new game or make old messages unprocessed.
    processedMessageIds: existing.processedMessageIds
  };
  appendLimited(next.recentEvents, {
    type: 'route_reset',
    groupId: normalizedGroupId,
    senderId: normalizedSenderId,
    nickname: next.routes[key].nickname,
    at: new Date().toISOString()
  }, RECENT_EVENTS_LIMIT);
  saveState(state, next);
  return replaceState(state, next);
}

function resetGame(state) {
  const next = cloneForSettlement(state);
  for (const route of Object.values(next.routes)) { route.score = 0; route.recentConversation = []; }
  next.winner = null;
  for (const record of Object.values(next.randomEvents || {})) { record.active = null; record.turns = 0; }
  appendLimited(next.recentEvents, { type: 'game_reset', at: new Date().toISOString() }, RECENT_EVENTS_LIMIT);
  saveState(state, next);
  return replaceState(state, next);
}

module.exports = {
  MAX_DELTA,
  MAX_SCORE,
  MIN_SCORE,
  recordMessage,
  recordFallback,
  recordCommand,
  resetRoute,
  resetGame,
  routeKey,
  settleTurn
};
