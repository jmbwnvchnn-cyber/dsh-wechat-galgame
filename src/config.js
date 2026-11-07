'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  port: 3000,
  positiveCooldownSeconds: 120,
  dailyPositiveCap: 15,
  repeatWindowHours: 24,
  groupAllowlist: [],
  characterAliases: {},
  modelEndpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  bridgeToken: '',
  respondOnlyWhenMentioned: true,
  randomEventsEnabled: true
});

function configError(message) {
  return new Error(`配置错误: ${message}`);
}

function validatePort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw configError('port 必须是 1 到 65535 之间的整数。');
  }
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw configError(`${field} 必须是字符串数组，数组元素不能是空字符串。`);
  }
}

function rejectPlaceholder(value, field) {
  if (typeof value === 'string' && /(在这里填写|角色名|别名|随机令牌|your[_ -]?token|replace[_ -]?me)/i.test(value)) {
    throw configError(`${field} 仍是示例占位符；请在 config.json 中填写实际本地值。`);
  }
}

function validateEndpoint(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw configError('modelEndpoint 必须是非空 URL。');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw configError('modelEndpoint 必须是有效 URL。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw configError('modelEndpoint 只支持 http 或 https。');
  }
}

function validateAliases(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('characterAliases 必须是“角色名 -> 别名数组”的对象。');
  }
  for (const [character, aliases] of Object.entries(value)) {
    if (!character.trim()) throw configError('characterAliases 不能包含空角色名。');
    validateStringArray(aliases, `characterAliases.${character}`);
  }
}

/**
 * Load and validate config.json under root. Missing config uses safe local defaults;
 * bridgeToken remains empty until the operator supplies it in config.json.
 */
function loadConfig(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw configError('必须提供项目根目录。');
  }
  const configPath = path.resolve(root, 'config.json');
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    let raw;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
      userConfig = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw configError(`config.json 不是有效 JSON (${error.message})。`);
      throw configError(`无法读取 config.json (${error.message})。`);
    }
    if (userConfig === null || typeof userConfig !== 'object' || Array.isArray(userConfig)) {
      throw configError('config.json 顶层必须是对象。');
    }
  }

  const config = {
    ...DEFAULTS,
    ...userConfig,
    root: path.resolve(root),
    configPath
  };
  validatePort(config.port);
  for (const [key, max] of [['positiveCooldownSeconds', 86400], ['dailyPositiveCap', 1000], ['repeatWindowHours', 168]]) {
    if (!Number.isInteger(config[key]) || config[key] < 0 || config[key] > max) throw configError(`${key} 必须是 0 到 ${max} 的整数。`);
  }
  validateStringArray(config.groupAllowlist, 'groupAllowlist');
  config.groupAllowlist.forEach((group, index) => rejectPlaceholder(group, `groupAllowlist[${index}]`));
  validateAliases(config.characterAliases);
  for (const [character, aliases] of Object.entries(config.characterAliases)) {
    rejectPlaceholder(character, `characterAliases.${character}`);
    aliases.forEach((alias, index) => rejectPlaceholder(alias, `characterAliases.${character}[${index}]`));
  }
  validateEndpoint(config.modelEndpoint);
  if (typeof config.bridgeToken !== 'string') {
    throw configError('bridgeToken 必须是字符串；未配置时请使用 config.example.json 创建 config.json。');
  }
  rejectPlaceholder(config.bridgeToken, 'bridgeToken');
  if (typeof config.respondOnlyWhenMentioned !== 'boolean') {
    throw configError('respondOnlyWhenMentioned 必须是布尔值。');
  }
  if (typeof config.randomEventsEnabled !== 'boolean') throw configError('randomEventsEnabled 必须为布尔值。');
  if (config.wechatBridge?.enableAccessibility !== undefined && typeof config.wechatBridge.enableAccessibility !== 'boolean') {
    throw configError('wechatBridge.enableAccessibility 必须是布尔值。');
  }
  return Object.freeze(config);
}

/** Shared trigger policy for future message handlers. */
function shouldRespondToCharacter(message, activeConfig) {
  if (!activeConfig || activeConfig.respondOnlyWhenMentioned !== true) return true;
  return Boolean(message && message.isMentioned);
}

module.exports = { DEFAULTS, loadConfig, shouldRespondToCharacter };
