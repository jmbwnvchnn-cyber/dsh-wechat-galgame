'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PERSONA = Object.freeze({ name: '小鲸', aliases: [], prompt: '温柔真诚，喜欢倾听，用自然简短的语气聊天。' });

function loadPersona(root) {
  const file = path.join(root, 'data', 'persona.json');
  if (!fs.existsSync(file)) return { ...DEFAULT_PERSONA, aliases: [] };
  const persona = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!persona || typeof persona.name !== 'string' || !persona.name.trim() ||
      typeof persona.prompt !== 'string' || !Array.isArray(persona.aliases) ||
      persona.aliases.some((alias) => typeof alias !== 'string')) throw new Error('Invalid persona');
  return { name: persona.name.slice(0, 100), aliases: persona.aliases.slice(0, 30).map((a) => a.slice(0, 100)), prompt: persona.prompt.slice(0, 4000) };
}

function savePersona(root, persona) {
  const dir = path.join(root, 'data');
  const file = path.join(dir, 'persona.json');
  const temp = path.join(dir, '.persona.' + process.pid + '.' + Date.now() + '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(temp, JSON.stringify(persona, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  return persona;
}
module.exports = { DEFAULT_PERSONA, loadPersona, savePersona };
