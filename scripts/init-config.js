const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const target = path.join(__dirname, '..', 'config.json');
const config = {
  port: 3000, groupAllowlist: [], characterAliases: {},
  modelEndpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  modelName: '', modelApiKey: '', bridgeToken: crypto.randomBytes(32).toString('hex'),
  respondOnlyWhenMentioned: true,
  randomEventsEnabled: true,
  wechatBridge: { account: '', botUserId: '', dbDir: '', enableAccessibility: false }
};
try {
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('已为本机创建初始配置；请在打开的设置向导中完成设置。');
} catch (error) {
  if (error.code === 'EEXIST') { console.error('config.json 已存在，未覆盖。'); process.exitCode = 1; }
  else throw error;
}
