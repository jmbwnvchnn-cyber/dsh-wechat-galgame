"""JSON-only setup discovery; never sends messages."""
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data' / 'setup'
os.environ['WECHATAUTO_KEYS_DIR'] = str(DATA / 'keys')

def verify_identity(db, wxid):
    for rel, db_path, _ in db._db_files:
        if os.path.basename(db_path) != 'contact.db':
            continue
        conn = db._open(rel)
        try:
            row = conn.execute('SELECT username FROM contact WHERE username=? LIMIT 1', (wxid,)).fetchone()
            return bool(row and row[0] == wxid)
        finally:
            conn.close()
    return False

def run(request):
    from wechatauto import WeChatDB, WxParam
    from wechatauto.db import auto_detect_db_dir, list_accounts
    WxParam.ENABLE_FILE_LOGGER = False
    logging.disable(logging.CRITICAL)
    directory = auto_detect_db_dir()
    accounts = list_accounts(directory) if directory else []
    if request.get('action') == 'accounts':
        return {'accounts': [{'account': a['account'], 'wxid': a['wxid'], 'label': a['account'], 'dbDir': directory} for a in accounts]}
    if request.get('action') != 'groups':
        raise ValueError('invalid action')
    match = next((a for a in accounts if a['account'] == request.get('account')), None)
    if not match or request.get('dbDir') != directory:
        raise ValueError('account not detected')
    class BoundDB(WeChatDB):
        def _select_account_by_keys(self, candidates):
            return False
        def _try_other_accounts(self, *args, **kwargs):
            return False
    db = BoundDB(db_dir=directory, account=match['account'], workdir=str(DATA / 'db' / match['account']))
    if db.account != match['account'] or db.wxid != match['wxid']:
        raise ValueError('account mismatch')
    if not verify_identity(db, match['wxid']):
        raise ValueError('account identity cannot be verified')
    hits = db.search_contact(request.get('keyword', ''))
    groups = [{'id': h['username'], 'name': h.get('remark') or h.get('nick_name') or h['username']} for h in hits if re.fullmatch(r'[A-Za-z0-9_-]+@chatroom', h.get('username') or '')]
    return {'account': match['account'], 'wxid': match['wxid'], 'dbDir': directory, 'groups': groups, 'truncated': len(hits) >= 50}

if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('request too large')
        request = json.loads(raw)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = run(request)
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        print(json.dumps({'error': '检测失败，请确认微信已登录且账号数据库可用'}, ensure_ascii=False))
        sys.exit(1)
