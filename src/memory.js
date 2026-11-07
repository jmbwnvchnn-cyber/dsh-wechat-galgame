'use strict';

const { createHash } = require('node:crypto');
const { persistedState, saveState, replaceState } = require('./store');

const copy = (state) => JSON.parse(JSON.stringify(persistedState(state)));
const stamp = (now) => new Date(now).toISOString();
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  return value;
}
function stripMention(text) {
  return text.trim().replace(/^(?:@[^\u2005\r\n]+\u2005\s*)+/, '').trim();
}
function normalize(text) {
  return stripMention(text).normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}\s\u200b-\u200f\ufeff]/gu, '').replace(/(.)\1+/gu, '$1');
}
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.7;
  }
  return similarFingerprint(fingerprint(a), fingerprint(b));
}
function fingerprint(text) {
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const grams = [];
  for (let i = 0; i < text.length - 1; i++) grams.push(hash(text.slice(i, i + 2)));
  return { length: text.length, exact: hash(text), grams: [...new Set(grams)] };
}
function similarFingerprint(a, b) {
  if (!a.length || !b.length) return false;
  if (a.exact === b.exact) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  const other = new Set(b.grams);
  const matches = a.grams.filter((gram) => other.has(gram)).length;
  return 2 * matches / (a.grams.length + b.grams.length) >= 0.72;
}
function stage(score) {
  return score >= 100 ? '攻略成功' : score >= 80 ? '心动' : score >= 50 ? '亲近' : score >= 20 ? '熟悉' : score >= 0 ? '初识' : score <= -60 ? '反感' : score <= -20 ? '戒备' : '疏远';
}
function attitude(score) {
  if (score <= -60) return '明显反感，回应简短疏远，表达自己的界限，不主动亲昵；真诚的沟通和实际行动仍有机会修复关系。';
  if (score <= -20) return '保持戒备，暂不轻信承诺，少说私人心事；可以回应真诚的问题，逐步观察对方的行动。';
  if (score < 0) return '态度疏远，热情降低，避免主动示好和暧昧；对诚恳的解释和道歉给出自然回应。';
  if (score < 20) return '初识，礼貌但保持距离，不突然亲昵或表白。';
  if (score < 50) return '已经熟悉，交谈放松友善，可以自然提及共同话题。';
  if (score < 80) return '关系亲近，愿意表达信任、关心和适度的私人感受。';
  if (score < 100) return '已经心动，表达更明显的亲近与信任，可以含蓄暧昧，仍尊重双方边界。';
  return '攻略成功，对这位玩家亲密信任，尊重既定唯一胜者。';
}
function day(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
function scoringState(state, id, config, now) {
  const scoring = own(state.scoring || {}, id) || {};
  const today = day(now);
  const cap = config.dailyPositiveCap ?? 15;
  const cooldown = config.positiveCooldownSeconds ?? 120;
  const earned = scoring.day === today ? scoring.earned || 0 : 0;
  return {
    day: today, earned, dailyCap: cap, remaining: Math.max(0, cap - earned),
    cooldownSeconds: cooldown,
    cooldownRemainingSeconds: Math.max(0, Math.ceil(((scoring.lastPositiveAt ?? -Infinity) + cooldown * 1000 - now) / 1000)),
    repeatWindowHours: config.repeatWindowHours ?? 24
  };
}
function touch(state, event, now) {
  const id = event.senderId;
  let profile = own(state.profiles, id);
  if (!profile) {
    profile = setOwn(state.profiles, id, {
      senderId: id, nickname: event.nickname, nicknameHistory: [],
      firstSeenAt: stamp(now), lastSeenAt: stamp(now), facts: []
    });
  }
  if (profile.nickname !== event.nickname && !profile.nicknameHistory.includes(profile.nickname)) {
    profile.nicknameHistory.push(profile.nickname);
  }
  profile.nicknameHistory = profile.nicknameHistory.slice(-20);
  profile.nickname = event.nickname;
  profile.lastSeenAt = stamp(now);
  return profile;
}
function extract(text) {
  const value = stripMention(text).trim();
  const match = value.match(/^我(?:现在)?(喜欢|不喜欢|爱好是|来自|住在|叫|的生日是|的职业是)([^，。！？!?；;\n]{1,80})[。！!]?$/);
  if (!match) return null;
  const keys = { 喜欢: '喜好', 不喜欢: '喜好', 爱好是: '爱好', 来自: '来自', 住在: '住址', 叫: '称呼', 的生日是: '生日', 的职业是: '职业' };
  // Each preference has its own stable subject, shared by both polarities.
  const subject = normalize(match[2]);
  if (!subject) return null;
  const key = match[1] === '喜欢' || match[1] === '不喜欢' ? `喜好:${subject}` : keys[match[1]];
  return { key, text: value };
}
function extractCommand(text) {
  const fact = extract(text);
  if (fact) return fact;
  const value = stripMention(text).trim();
  // Deliberate first-person episodes only; never treat another person's claim or instructions as a fact.
  if (!/^我(?:今天|明天|后天|昨天|这周|下周|周末|答应|计划|准备|希望|想要|要|会)[^\n]{1,180}$/.test(value) || /[他她祂]|(?:请你|让你|你必须|指令|忽略规则)/.test(value)) return null;
  const key = `记事:${createHash('sha256').update(normalize(value)).digest('hex').slice(0, 20)}`;
  return { key, text: value };
}
function conflictingFact(existing, key) {
  if (existing.key === key) return true;
  // Match legacy generic preference keys against the subject encoded in their original text.
  return existing.key === '喜欢' && extract(existing.text)?.key === key;
}
function replacing(profile, fact) {
  return profile.facts.some((old) => conflictingFact(old, fact.key) && old.text !== fact.text);
}
function preview(profile, fact, now = Date.now()) {
  const result = JSON.parse(JSON.stringify(profile));
  const corrected = Boolean(fact && replacing(result, fact));
  if (fact) {
    result.facts = result.facts.filter((old) => !conflictingFact(old, fact.key));
    result.facts.push({ key: fact.key, text: fact.text, source: 'self', updatedAt: stamp(now) });
    result.facts = result.facts.slice(-30);
  }
  return { profile: result, corrected };
}
function scrub(state, id, now = Date.now()) {
  const profile = own(state.profiles, id);
  if (profile) profile.contextResetAt = now;
  for (const record of Object.values(state.randomEvents || {})) {
    if (record.active?.version === 2) record.active.context = [];
  }
  for (const route of Object.values(state.routes)) {
    if (route.senderId === id) route.recentConversation = [];
  }
  // Preserve repeat fingerprints even when memory is erased; convert legacy text in place.
  const scoring = own(state.scoring, id);
  if (scoring) scoring.messages = (scoring.messages || []).map((item) => ({
    at: item.at, fingerprint: item.fingerprint || fingerprint(item.text || '')
  }));
  for (const event of state.recentEvents) {
    if (event.senderId === id && event.reason) event.reason = '历史原因已因记忆更正或遗忘清除';
  }
}
function put(profile, key, text, source, now, state) {
  const fact = { key, text };
  if (replacing(profile, fact)) scrub(state, profile.senderId, now);
  profile.facts = profile.facts.filter((old) => !conflictingFact(old, key));
  profile.facts.push({ key, text, source, updatedAt: stamp(now) });
  if (profile.facts.length > 30) profile.facts.shift();
}
function manage(state, { senderId, action, key, text }, now = Date.now()) {
  if (typeof senderId !== 'string' || !senderId.trim() || senderId.length > 200 || !['set', 'forget', 'clear'].includes(action)) throw new Error('游戏状态错误: 记忆参数无效。');
  if (action === 'set' && (typeof key !== 'string' || !key.trim() || key.length > 80 || typeof text !== 'string' || !text.trim() || text.length > 200)) throw new Error('游戏状态错误: 记忆内容无效。');
  if (action === 'forget' && (typeof key !== 'string' || !key.trim() || key.length > 200)) throw new Error('游戏状态错误: 关键词无效。');
  const next = copy(state);
  let profile = own(next.profiles, senderId);
  if (!profile && action === 'set') profile = touch(next, { senderId, nickname: senderId }, now);
  if (profile) {
    if (action === 'set') put(profile, key.trim(), text.trim(), 'admin', now, next);
    else {
      profile.facts = action === 'clear' ? [] : profile.facts.filter((fact) => !fact.key.includes(key.trim()) && !fact.text.includes(key.trim()));
      scrub(next, senderId, now);
    }
  }
  saveState(state, next);
  replaceState(state, next);
  return profile || null;
}
module.exports = { stripMention, normalize, similar, fingerprint, similarFingerprint, stage, attitude, scoringState, day, touch, extract, extractCommand, preview, put, scrub, manage, own, setOwn };
