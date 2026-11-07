'use strict';

const fs = require('node:fs');
const path = require('node:path');
const eventFormat = require('./event-format');

const STATE_VERSION = 1;
const STATE_FILE = 'game-state.json';

function createEmptyState() {
  return {
    version: STATE_VERSION,
    routes: {},
    profiles: {},
    scoring: {},
    randomEvents: {},
    winner: null,
    recentEvents: []
  };
}

function stateError(message, cause) {
  const error = new Error(`游戏存档错误: ${message}`);
  error.cause = cause;
  return error;
}

function validateState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw stateError('顶层必须是对象。');
  }
  if (value.version !== STATE_VERSION) {
    throw stateError(`不支持的存档版本 ${String(value.version)}。`);
  }
  if (value.routes === null || typeof value.routes !== 'object' || Array.isArray(value.routes)) {
    throw stateError('routes 必须是对象。');
  }
  const perfectRouteKeys = [];
  for (const [key, route] of Object.entries(value.routes)) {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) {
      throw stateError(`routes.${key} 必须是对象。`);
    }
    if (typeof route.groupId !== 'string' || typeof route.senderId !== 'string' || typeof route.nickname !== 'string') {
      throw stateError(`routes.${key} 的身份字段必须是字符串。`);
    }
    if (key !== JSON.stringify([route.groupId, route.senderId])) {
      throw stateError(`routes.${key} 的键与路线身份不一致。`);
    }
    if (!Number.isInteger(route.score) || route.score < -100 || route.score > 100) {
      throw stateError(`routes.${key}.score 必须是 -100 到 100 的整数。`);
    }
    if (route.score === 100) perfectRouteKeys.push(key);
    if (!Array.isArray(route.recentConversation) || !Array.isArray(route.processedMessageIds)) {
      throw stateError(`routes.${key} 缺少有效的历史或消息去重数组。`);
    }
  }
  if (value.winner !== null && (typeof value.winner !== 'object' || Array.isArray(value.winner))) {
    throw stateError('winner 必须是 null 或对象。');
  }
  if (value.winner === null && perfectRouteKeys.length !== 0) {
    throw stateError('没有 winner 时不能存在 100 分路线。');
  }
  if (value.winner !== null) {
    const winnerRoute = value.routes[value.winner.routeKey];
    if (
      typeof value.winner.routeKey !== 'string' ||
      perfectRouteKeys.length !== 1 ||
      perfectRouteKeys[0] !== value.winner.routeKey ||
      !winnerRoute ||
      winnerRoute.score !== 100 ||
      value.winner.score !== 100 ||
      value.winner.groupId !== winnerRoute.groupId ||
      value.winner.senderId !== winnerRoute.senderId
    ) {
      throw stateError('winner 必须与唯一的 100 分路线完全一致。');
    }
  }
  if (!Array.isArray(value.recentEvents)) {
    throw stateError('recentEvents 必须是数组。');
  }
  if (value.randomEvents !== undefined) {
    if (!value.randomEvents || typeof value.randomEvents !== 'object' || Array.isArray(value.randomEvents)) throw stateError('randomEvents 必须是对象。');
    for (const record of Object.values(value.randomEvents)) {
      if (!record || typeof record.day !== 'string' || !Number.isInteger(record.count) || record.count < 0 ||
          !Number.isInteger(record.turns) || record.turns < 0 ||
          !(record.lastTriggeredAt === null || Number.isFinite(record.lastTriggeredAt))) throw stateError('随机事件计数无效。');
      const a = record.active;
      if (a !== null && (!a || typeof a.id !== 'string' || !a.id || typeof a.title !== 'string' || typeof a.text !== 'string' ||
          !Number.isFinite(a.createdAt) || a.expiresAt - a.createdAt !== 600000 || !Number.isFinite(a.expiresAt) ||
          !Array.isArray(a.options) || a.options.length !== 3 || new Set(a.options.map(o => o?.label)).size !== 3 ||
          a.options.some(o => !o || !'ABC'.includes(o.label) || o.label.length !== 1 || typeof o.text !== 'string' || typeof o.reply !== 'string' || !Number.isInteger(o.delta) || o.delta < -3 || o.delta > 3) ||
          !a.participants || typeof a.participants !== 'object' || Array.isArray(a.participants))) throw stateError('活动随机事件无效。');
      if (a && Object.values(a.participants).some(p => !p || !['A','B','C'].includes(p.label) || typeof p.messageId !== 'string' || !Number.isFinite(p.at))) throw stateError('事件参与记录无效。');
      if (a?.version === 2) {
        if (!a.challenges || typeof a.challenges !== 'object' || Array.isArray(a.challenges) || !Array.isArray(a.context) || a.context.length > 8) throw stateError('个人事件数据无效。');
        if (Object.values(a.challenges).some(c => !c || typeof c.nickname !== 'string' || !Number.isFinite(c.scoreAtClaim) || c.scoreAtClaim < -100 || c.scoreAtClaim > 100 || !Number.isFinite(c.issuedAt) || c.issuedAt >= a.expiresAt || !eventFormat.storedChoices(c.options))) throw stateError('个人选项无效。');
        if (Object.keys(a.participants).some(user => !Object.hasOwn(a.challenges,user))) throw stateError('参与者缺少个人选项。');
      }
    }
  }
}

function attachStorage(state, storagePath) {
  Object.defineProperty(state, '_storagePath', {
    value: storagePath,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return state;
}

/**
 * Loads the versioned game state synchronously. A corrupt or unsupported file is
 * deliberately left untouched and causes loading to fail, rather than silently
 * replacing user data with an empty game.
 */
function loadState(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw stateError('必须提供数据目录。');
  }
  const resolvedDir = path.resolve(dataDir);
  const storagePath = path.join(resolvedDir, STATE_FILE);
  if (!fs.existsSync(storagePath)) {
    return attachStorage(createEmptyState(), storagePath);
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    validateState(state);
    if (state.profiles === undefined) state.profiles = {};
    if (state.scoring === undefined) state.scoring = {};
    if (state.randomEvents === undefined) state.randomEvents = {};
    if (!state.profiles || typeof state.profiles !== 'object' || Array.isArray(state.profiles) || !state.scoring || typeof state.scoring !== 'object' || Array.isArray(state.scoring)) throw stateError('profiles/scoring 必须是对象。');
  } catch (error) {
    const reported = stateError(`无法加载 ${storagePath}；原文件已保留。${error.message ? ` ${error.message}` : ''}`, error);
    console.error(reported.message);
    throw reported;
  }
  return attachStorage(state, storagePath);
}

function persistedState(state) {
  return {
    ...state,
    version: STATE_VERSION,
    routes: state.routes,
    profiles: state.profiles || {},
    scoring: state.scoring || {},
    winner: state.winner,
    recentEvents: state.recentEvents
  };
}

/** Write a complete snapshot via same-directory temp file and atomic replacement. */
function saveState(state, nextState) {
  const storagePath = state && state._storagePath;
  if (typeof storagePath !== 'string') {
    throw stateError('状态没有关联的存档路径；请使用 loadState 创建状态。');
  }
  const parent = path.dirname(storagePath);
  const tempPath = path.join(parent, `.${STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(persistedState(nextState), null, 2)}\n`;

  fs.mkdirSync(parent, { recursive: true });
  try {
    fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, storagePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // The original save remains authoritative; leave a failed temp file only if cleanup also fails.
    }
    throw stateError(`无法原子保存 ${storagePath}。${error.message ? ` ${error.message}` : ''}`, error);
  }
}

function replaceState(state, nextState) {
  state.version = nextState.version;
  state.routes = nextState.routes;
  state.profiles = nextState.profiles;
  state.scoring = nextState.scoring;
  state.randomEvents = nextState.randomEvents || {};
  state.winner = nextState.winner;
  state.recentEvents = nextState.recentEvents;
  return state;
}

module.exports = {
  STATE_FILE,
  STATE_VERSION,
  createEmptyState,
  loadState,
  persistedState,
  replaceState,
  saveState,
  stateError,
  validateState
};
