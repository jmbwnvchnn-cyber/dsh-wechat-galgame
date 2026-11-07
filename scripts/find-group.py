"""Local account and contact-ID lookup; does not read message bodies or send."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2 or not sys.argv[1].strip():
    raise SystemExit('Usage: python scripts/find-group.py "exact group name"')
with (root / 'config.json').open(encoding='utf-8-sig') as f:
    w = json.load(f)['wechatBridge']
account = w.get('account', '')
if not account or any(x in account for x in ('/', '\\', '..')):
    raise SystemExit('Set wechatBridge.account to the account directory name first.')
from wechatauto import WeChatDB
workdir = root / 'data' / 'wechat-bridge' / 'db'
workdir.mkdir(parents=True, exist_ok=True)
kwargs = {'account': account, 'workdir': str(workdir)}
if w.get('dbDir'):
    kwargs['db_dir'] = w['dbDir']
db = WeChatDB(**kwargs)
print('Account wxid:', db.wxid)
hits = db.search_contact(sys.argv[1])
if len(hits) >= 50:
    print('Search may be truncated; use a more specific name.')
for contact in hits:
    username = contact.get('username', '')
    if username.endswith('@chatroom'):
        print('Group:', username, '| name:', contact.get('nick_name', ''), '| remark:', contact.get('remark', ''))
