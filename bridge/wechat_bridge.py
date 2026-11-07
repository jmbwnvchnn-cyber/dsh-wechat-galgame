"""Local, at-most-once WeChat bridge. See THIRD_PARTY_NOTICES.md."""
import json
import hashlib
import logging
import os
from pathlib import Path
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data' / 'wechat-bridge'
STATE = DATA / 'watermark.json'
STAGES = {'config': '读取配置', 'imports': '导入 Windows/UIA 依赖',
          'window': '定位唯一微信窗口', 'database': '连接并核验数据库账号',
          'uia': '只读核验聊天控件', 'accessibility': '启用已授权的进程无障碍标志',
          'baseline': '读取消息启动水位', 'ready': '连接就绪'}
STARTED = time.monotonic()
CURRENT_STAGE = 'config'
SAFE_REASONS = ('需要恰好一个可见的微信主窗口', '无法确认 UIA 已绑定唯一微信窗口',
                'UIA未启用：请在设置中明确勾选微信无障碍兼容后保存并启动，或手动启用微信 UIA',
                '微信无障碍兼容启用失败：控件核验未通过，已停止连接；请检查微信版本和权限',
                '数据库账号与配置不一致', '未找到微信消息数据库', '已有桥接进程运行',
                '无法读取群消息水位', 'wechatBridge.enableAccessibility 必须为布尔值',
                '微信窗口未通过安全核验：请先手动登录，并确认窗口和控件树可读取',
                '连接检查启动超时，请检查当前阶段和微信状态')


def safe_reason(exc):
    return next((reason for reason in SAFE_REASONS if reason in str(exc)),
                'Windows/UIA 依赖导入失败，请检查随附运行环境和 DLL' if CURRENT_STAGE == 'imports'
                else '桥接启动或运行失败，请检查微信登录、账号和数据库权限')


def message_error_reason(exc):
    reasons = ('无法获取群的显示名称', '联系人搜索结果可能被截断；停止发送',
               '群名称不唯一或无法验证；停止发送', '无法确认微信当前会话；停止发送',
               '发送结果不确定，不重试', '微信窗口发生变化')
    return str(exc) if str(exc) in reasons else type(exc).__name__


def startup_stage(stage, error=None):
    """Only fixed diagnostics leave this process; never serialize DB/model errors."""
    global CURRENT_STAGE
    CURRENT_STAGE = stage
    logger = setup_bridge_logger()
    logger.info('启动阶段：%s；已用 %.1f 秒%s', STAGES[stage], time.monotonic() - STARTED,
                '；' + error if error else '')
    progress, nonce = os.environ.get('GAL_BRIDGE_PROGRESS'), os.environ.get('GAL_BRIDGE_NONCE')
    if progress and nonce:
        target = Path(progress)
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps({'nonce': nonce, 'pid': os.getpid(), 'stage': stage,
                                        'updatedAt': time.time(), **({'error': error} if error else {})}), encoding='utf-8')
        os.replace(temporary, target)


def account_data(account):
    """Keep account caches and message cursors isolated, without path input."""
    return DATA / 'accounts' / hashlib.sha256(account.encode('utf-8')).hexdigest()


def start_parent_watchdog():
    """Managed children die on pipe EOF, even during startup or blocked HTTP."""
    if os.environ.get('GAL_BRIDGE_MANAGED') != '1':
        return

    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        import msvcrt
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
        peek = ctypes.WinDLL('kernel32', use_last_error=True).PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                         ctypes.POINTER(wintypes.DWORD)]
        peek.restype = wintypes.BOOL

        def parent_alive():
            # This pipe carries no data. Poll for disconnection without a pending
            # synchronous stdin read that can stall native DLL initialization.
            return peek(handle, None, 0, None, None, None)
    else:
        fd = sys.stdin.fileno()
        def parent_alive():
            return os.read(fd, 1)

    def watch():
        try:
            while parent_alive():
                time.sleep(0.2)
        finally:
            os._exit(0)

    threading.Thread(target=watch, name='gal-parent-pipe', daemon=True).start()


def check_environment():
    """Read-only preflight: no DB open, UI interaction, listening or sending."""
    import importlib.metadata as metadata
    import requests
    import win32gui
    import win32clipboard
    import pythoncom
    import psutil
    from wechatauto import WeChatDB, WxParam
    WxParam.ENABLE_FILE_LOGGER = False
    logging.getLogger('wechatauto').disabled = True
    from wechatauto.uia_driver import WeChatUIA
    print('Python:', sys.version.split()[0])
    for package in ('wechatauto-replica', 'requests', 'pywin32', 'psutil'):
        print(f'  {package}: {metadata.version(package)}')
    print('桥接依赖及 Windows/UIA 模块导入通过。')
    if not (ROOT / 'config.json').exists():
        print('缺少 config.json，请先运行 node scripts/init-config.js。')
        return 2
    with (ROOT / 'config.json').open(encoding='utf-8-sig') as handle:
        settings = json.load(handle)
    bridge = settings.get('wechatBridge') or {}
    missing = [name for name, value in (
        ('groupAllowlist（目标群 ID）', settings.get('groupAllowlist')),
        ('wechatBridge.account（微信账号目录）', bridge.get('account')),
        ('wechatBridge.botUserId（登录账号 wxid）', bridge.get('botUserId')),
        ('bridgeToken', settings.get('bridgeToken')),
    ) if not value]
    if missing:
        print('还需配置：' + '、'.join(missing))
        return 2
    config()
    print('桥接配置格式通过；本次未连接微信、数据库或发送消息。')
    if not settings.get('modelName'):
        print('提示：模型名称尚未填写，聊天模型也需要配置。')
    return 0


def config():
    with (ROOT / 'config.json').open(encoding='utf-8-sig') as f:
        c = json.load(f)
    w = c.get('wechatBridge', {})
    if type(w.get('enableAccessibility', False)) is not bool:
        raise ValueError('wechatBridge.enableAccessibility 必须为布尔值')
    groups = c.get('groupAllowlist')
    if not isinstance(groups, list) or not groups or any(not isinstance(g, str) or not re.fullmatch(r'[A-Za-z0-9_-]+@chatroom', g) for g in groups):
        raise ValueError('groupAllowlist 必须非空且只包含真实群 ID（以 @chatroom 结尾）')
    if not isinstance(w.get('account'), str) or not w['account'].strip() or any(x in w['account'] for x in ('/', '\\', '..')):
        raise ValueError('wechatBridge.account 必须为微信账号目录名')
    if not isinstance(w.get('botUserId'), str) or not w['botUserId'].strip():
        raise ValueError('wechatBridge.botUserId 必须为登录账号的真实 wxid')
    if not isinstance(c.get('bridgeToken'), str) or not c['bridgeToken'].strip():
        raise ValueError('bridgeToken 不能为空')
    port = c.get('port', 3000)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('port 无效')
    return c, w, groups, f'http://127.0.0.1:{port}/webhook/wechat'


def save_state(state):
    target = account_data(state['account']) / 'watermark.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, target)


def valid_mark(mark):
    return (type(mark) is int and mark >= 0) or (isinstance(mark, dict) and type(mark.get('seq')) is int and mark['seq'] >= 0 and isinstance(mark.get('ids'), list) and all(isinstance(x, str) for x in mark['ids']))

def row_id(row):
    if type(row.get('local_id')) is not int or not isinstance(row.get('shard'), str) or not row['shard']:
        return None
    return f"{row['shard']}:{row['local_id']}"

def pending_rows(rows, mark):
    return sorted((row for row in rows if type(row.get('sort_seq')) is int and row_id(row) is not None and (row['sort_seq'] > mark['seq'] or (row['sort_seq'] == mark['seq'] and row_id(row) not in mark['ids']))), key=lambda row: row['sort_seq'])

def advance_mark(mark, row):
    if row['sort_seq'] > mark['seq']:
        mark['seq'] = row['sort_seq']
        mark['ids'] = []
    key = row_id(row)
    if key is not None and key not in mark['ids']:
        mark['ids'].append(key)

def load_state(account):
    target = account_data(account) / 'watermark.json'
    legacy = not target.exists()
    source = STATE if legacy else target
    if not source.exists():
        return {'account': account, 'groups': {}}
    with source.open(encoding='utf-8') as f:
        state = json.load(f)
    # A legacy cursor belongs only to its recorded account. Leave it intact so
    # switching back can still adopt it; never reset another account's cursor.
    if legacy and isinstance(state, dict) and state.get('account') != account:
        return {'account': account, 'groups': {}}
    if not isinstance(state, dict) or state.get('account') != account or not isinstance(state.get('groups'), dict) or any(not valid_mark(v) for v in state['groups'].values()):
        raise ValueError('桥接水位文件损坏或账号不符；请检查 data/wechat-bridge 下的账号水位文件')
    if legacy:
        save_state(state)
    return state


def mentions_self(source, bot_id):
    # Only structured WeChat atuserlist is evidence. Text and aliases are not.
    if isinstance(source, bytes):
        try:
            if source.startswith(b'\x28\xb5\x2f\xfd'):
                # Reuse the installed WeChat decoder for 4.x zstd metadata.
                from wechatauto import WeChatDB
                source = WeChatDB._friendly_content(source, '文本')
            else:
                source = source.decode('utf-8')
        except Exception:
            return False
    if not isinstance(source, str) or not source.strip():
        return False
    try:
        root = ET.fromstring(source.strip().strip('\x00'))
        return any(bot_id in (node.text or '').split(',') for node in root.iter() if node.tag.rsplit('}', 1)[-1] == 'atuserlist')
    except ET.ParseError:
        return False


def strip_sender_prefix(text, sender):
    return re.sub(r'^' + re.escape(sender) + r':\s*', '', text, count=1)


def message_text(message):
    sender, text = message.get('sender_username'), message.get('content')
    if not isinstance(sender, str) or not isinstance(text, str):
        return None
    text = strip_sender_prefix(text, sender).strip()
    if message.get('type') == '文本':
        return text or None
    if message.get('type') not in ('文件/链接/卡片', '引用', '引用消息') or len(text) > 200000:
        return None
    # WeChat DB stores quoted text as appmsg subtype 57, not as plain text.
    # Read only the fresh title; the referenced old message is never a new input.
    try:
        root = ET.fromstring(text)
        app = root if root.tag == 'appmsg' else root.find('./appmsg') if root.tag == 'msg' else None
        if app is None or app.findtext('type', '').strip() != '57' or app.find('refermsg') is None:
            return None
        return (app.findtext('title') or '').strip() or None
    except ET.ParseError:
        return None


def add_group_context(event, db, rows, message, bot_id):
    """Attach bounded same-chat material only after a genuine mention passed."""
    until = message.get('create_time')
    if not isinstance(until, (int, float)):
        return
    context = []
    for row in sorted(rows, key=lambda item: item.get('sort_seq') or 0):
        created, sender = row.get('create_time'), row.get('sender_username')
        if (not isinstance(created, (int, float)) or
                not 0 <= until - created <= 600 or row.get('sort_seq', 0) > message.get('sort_seq', 0) or
                row_id(row) == row_id(message) or not isinstance(sender, str) or not sender or
                not isinstance(row.get('content'), str)):
            continue
        text = message_text(row)
        if not text:
            continue
        command_text = re.sub(r'^(?:@[^\u2005\r\n]+\u2005\s*)+', '', text).strip()
        if not text or command_text.startswith('/'):
            continue
        try:
            nickname = '角色' if sender == bot_id else db.get_nickname(sender) or '群友'
        except Exception:
            nickname = '群友'
        context.append({'chat_id': event['chat_id'], 'user_id': sender, 'nickname': str(nickname)[:40], 'text': text[:240], 'at': created})
    event['group_context'] = context[-8:]
    # requests serializes JSON with escaped Unicode; budget the actual wire form.
    while event['group_context'] and len(json.dumps(event).encode('utf-8')) > 15000:
        event['group_context'].pop(0)


def event_for(db, group, msg, bot_id):
    sender = msg.get('sender_username')
    if not isinstance(sender, str) or not sender or sender.isdecimal() or sender.endswith('@chatroom') or sender == bot_id:
        return None
    local_id, shard = msg.get('local_id'), msg.get('shard')
    text = message_text(msg)
    if type(local_id) is not int or not shard or not isinstance(text, str) or not text.strip():
        return None
    content = re.sub(r'^(?:@[^\u2005\r\n]+\u2005\s*)+', '', text.strip()).strip()
    if content.startswith('/') and not re.fullmatch(r'/(?:好感|帮助|记忆|记住|忘记|事件|选择)(?:\s+[\s\S]*)?', content):
        return None
    row = db.get_message_row(group, local_id, shard=shard)
    if not row or row.get('sender_username') != sender or not mentions_self(row.get('source'), bot_id):
        return None
    return {'chat_id': group, 'chat_type': 'group', 'user_id': sender,
            'nickname': db.get_nickname(sender) or sender, 'text': text.strip(),
            'msg_id': f'{group}:{shard}:{local_id}', 'at_me': True, 'is_self': False}


def send_once(db, uia, group, reply):
    # Search by a unique contact display name, then verify the open title.
    title = db.get_nickname(group)
    if not title or title == group:
        raise RuntimeError('无法获取群的显示名称')
    hits = db.search_contact(title)
    # search_contact is capped at 50 rows; a full page cannot prove uniqueness.
    if len(hits) >= 50:
        raise RuntimeError('联系人搜索结果可能被截断；停止发送')
    matches = {x.get('username') for x in hits if title in (x.get('nick_name'), x.get('remark'))}
    if matches != {group}:
        raise RuntimeError('群名称不唯一或无法验证；停止发送')
    if not uia.ensure_window() or not uia._force_foreground(uia._win.NativeWindowHandle):
        raise RuntimeError('无法确认微信当前会话；停止发送')
    # Reuse whale-girl's send path: keep the already-open target chat instead
    # of searching for it again (new WeChat search-list scans can stall).
    if uia.current_chat() != title and not uia.open_chat(title):
        raise RuntimeError('无法确认微信当前会话；停止发送')
    if uia.current_chat() != title or not uia.ensure_window():
        raise RuntimeError('无法确认微信当前会话；停止发送')
    # Exactly one call: even an exception/False may mean Enter was pressed.
    if not uia.send_text(reply):
        raise RuntimeError('发送结果不确定，不重试')


def candidate_wechat_windows():
    import win32gui
    import win32process
    import psutil
    from wechatauto.uia_driver import _title_is_main
    found = []
    def collect(hwnd, _):
        title = win32gui.GetWindowText(hwnd)
        if win32gui.IsWindowVisible(hwnd) and (_title_is_main(title) or 'WeChat' in title):
            pid = win32process.GetWindowThreadProcessId(hwnd)[1]
            if psutil.Process(pid).name().lower() in {'weixin.exe', 'wechat.exe'}:
                found.append(hwnd)
        return True
    # Propagate enumeration/process races instead of silently losing a candidate.
    win32gui.EnumWindows(collect, None)
    return found


def inspect_chat_ui(root, hwnd, max_nodes=6000, max_depth=40, timeout=4.0):
    """Accept independent chat anchors; only classify an empty Qt tree after a full scan."""
    try:
        if root is None or getattr(root, 'NativeWindowHandle', None) != hwnd:
            return 'blocked'
        cls = getattr(root, 'ClassName', '') or ''
    except Exception:
        return 'blocked'
    qt_wrapper = bool(re.fullmatch(r'Qt\d+QWindow(?:Icon)?', cls))
    if 'login' in cls.lower() or not (cls == 'mmui::MainWindow' or qt_wrapper):
        return 'blocked'
    queue, seen, anchors, visited = [(root, 0)], 0, set(), {}
    materialized, chat_anchor_seen, truncated = False, False, False
    deadline = time.monotonic() + timeout
    while queue and seen < max_nodes and time.monotonic() < deadline:
        node, depth = queue.pop(0)
        if id(node) in visited:
            continue
        visited[id(node)] = node  # Retain wrappers so Python cannot recycle IDs.
        seen += 1
        try:
            node_class = getattr(node, 'ClassName', '') or ''
            if 'login' in node_class.lower():
                return 'blocked'
            materialized |= node_class.startswith('mmui::')
            aid = getattr(node, 'AutomationId', '') or ''
            if 'login' in aid.lower():
                return 'blocked'
            # An ancestor's dotted ID is not this node's role. Count at most
            # one terminal role per actual non-root node, never path segments.
            role = 'main_tabbar' if node_class == 'mmui::MainTabBar' else aid.strip().lower().rsplit('.', 1)[-1]
            chat_anchor_seen |= role in {'session_list', 'chat_input_field', 'main_tabbar'}
            if depth > 0 and role in {'session_list', 'chat_input_field', 'main_tabbar'}:
                anchors.add(role)
                if len(anchors) >= 2 and anchors & {'session_list', 'chat_input_field'}:
                    return 'chat'
            children = node.GetChildren()
            remaining = max(0, max_nodes - seen - len(queue)) if depth < max_depth else 0
            truncated |= len(children) > remaining
            queue.extend((child, depth + 1) for child in children[:remaining])
        except Exception:
            return 'blocked'
    # Without chat proof, a partial tree must never be treated as an empty Qt shell.
    if truncated or queue or time.monotonic() > deadline:
        return 'blocked'
    return 'qt-empty' if qt_wrapper and not materialized and not chat_anchor_seen else 'blocked'


def has_chat_ui(root, hwnd, **bounds):
    return inspect_chat_ui(root, hwnd, **bounds) == 'chat'


def pinned_window_present(candidate_windows, windows):
    # Like whale-girl's account-window guard, retain the verified window while
    # it is still present. Extra windows must never become replacement targets.
    return len(windows) == 1 and windows[0] in candidate_windows()


def make_bound_uia(base, candidate_windows, windows):
    class BoundUIA(base):
        # Avoid the library's default-account DB lookup and its shared temp files.
        @staticmethod
        def _resolve_search_keyword(keyword):
            return [keyword]

        def _find_main(self):
            # Never ask the base driver to scan or activate other windows.
            if not pinned_window_present(candidate_windows, windows):
                return None
            win = self._anchor(windows[0])
            return win if has_chat_ui(win, windows[0]) else None

        def can_activate_accessibility(self):
            try:
                return (len(windows) == 1 and candidate_windows() == windows and
                        inspect_chat_ui(self._anchor(windows[0]), windows[0]) == 'qt-empty')
            except Exception:
                return False

        def ensure_window(self, wake=True, timeout=None):
            # Do not auto-login, wake, or select a different candidate.
            if not pinned_window_present(candidate_windows, windows):
                return False
            win = self._find_main()
            if win is None or getattr(win, 'NativeWindowHandle', None) != windows[0]:
                return False
            self._win = win
            return True
    return BoundUIA()


def prepare_uia(uia, candidate_windows, windows, enabled=False, gate_module=None):
    if uia.ensure_window():
        return
    if enabled is not True:
        raise RuntimeError(SAFE_REASONS[2])
    if candidate_windows() != windows:
        raise RuntimeError(SAFE_REASONS[0])
    if not getattr(uia, 'can_activate_accessibility', lambda: False)():
        raise RuntimeError(SAFE_REASONS[-2])
    startup_stage('accessibility')
    if gate_module is None:
        from wechatauto import accessibility as gate_module
    gate_module.GATE_CACHE_FILE = str(DATA / 'accessibility-gate.json')
    gate = gate_module.AccessibilityGate
    original = gate.__dict__['_mmui_present']
    # The library restores a rejected candidate's byte. Use our stronger pinned
    # proof as its verifier so a generic mmui/login node cannot accept a write.
    def verify(hwnd, *args, **kwargs):
        deadline = time.monotonic() + 2.0
        while True:
            try:
                if hwnd != windows[0] or candidate_windows() != windows:
                    return False
                if uia.ensure_window():
                    return True
            except Exception:
                # Return False so the dependency can roll back its candidate byte.
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(0.2, remaining))
    gate._mmui_present = staticmethod(verify)
    try:
        activated = gate._hot_activate_accessibility(windows[0], verify=True)
    except Exception:
        activated = False
    finally:
        gate._mmui_present = original
    if not activated or candidate_windows() != windows or not uia.ensure_window():
        raise RuntimeError(SAFE_REASONS[3])


def setup_bridge_logger():
    DATA.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger('gal.bridge')
    logger.propagate = False
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        formatter = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
        for handler in (logging.FileHandler(DATA / 'bridge.log', encoding='utf-8'), logging.StreamHandler()):
            handler.setFormatter(formatter)
            logger.addHandler(handler)
    return logger


def check_connection(timeout=120):
    """A blocked DB/COM call cannot strand an explicitly requested dry run."""
    def expire():
        try:
            startup_stage(CURRENT_STAGE, SAFE_REASONS[-1])
            print('连接检查超时：' + STAGES[CURRENT_STAGE], file=sys.stderr, flush=True)
        finally:
            os._exit(124)
    deadline = threading.Timer(timeout, expire)
    deadline.daemon = True
    deadline.start()
    try:
        run(check_connection=True)
    finally:
        deadline.cancel()

def read_startup_rows(db, groups):
    """Read startup watermarks strictly; absent group tables are valid empty groups."""
    shards = db._message_dbs()
    if not shards:
        raise RuntimeError('未找到微信消息数据库，请检查微信登录及数据库权限')
    result = {group: [] for group in groups}
    for rel in shards:
        conn = db._open(rel)
        try:
            shard = db._shard_label(conn)
            for group in groups:
                table = 'Msg_' + hashlib.md5(group.encode()).hexdigest()
                exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
                if exists:
                    rows = conn.execute(f'SELECT local_id, local_type, real_sender_id, create_time, message_content, source, packed_info_data, compress_content, server_id, sort_seq FROM "{table}" ORDER BY sort_seq DESC, local_id ASC LIMIT 200').fetchall()
                    result[group].extend({'local_id': row[0], 'sort_seq': row[9], 'shard': shard} for row in rows)
        finally:
            conn.close()
    return {group: sorted(rows, key=lambda row: row['sort_seq'], reverse=True)[:200] for group, rows in result.items()}

def set_startup_watermarks(state, groups, startup_rows):
    for group in groups:
        rows = startup_rows[group]
        seq = max((row.get('sort_seq', -1) for row in rows), default=0)
        if type(seq) is not int or seq < 0:
            raise RuntimeError('无法读取群消息水位')
        previous = state['groups'].get(group, 0)
        previous_seq = previous if type(previous) is int else previous['seq']
        mark = {'seq': max(previous_seq, seq), 'ids': []}
        for row in rows:
            if row.get('sort_seq') == mark['seq']:
                advance_mark(mark, row)
        state['groups'][group] = mark


def run(check_connection=False):
    startup_stage('config')
    c, w, groups, url = config()
    DATA.mkdir(parents=True, exist_ok=True)
    import msvcrt
    lock = (DATA / 'bridge.lock').open('a+b')
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        raise RuntimeError('已有桥接进程运行')
    startup_stage('imports')
    import requests
    import win32gui
    from wechatauto import WeChatDB, WxParam
    WxParam.ENABLE_FILE_LOGGER = False
    # Replica configures the root logger and may log pasted message content.
    logging.getLogger('wechatauto').disabled = True
    logger = setup_bridge_logger()
    from wechatauto.uia_driver import WeChatUIA
    os.environ.setdefault('WECHATAUTO_RHYTHM', 'off')
    candidate_windows = candidate_wechat_windows

    startup_stage('window')
    windows = candidate_windows()
    if len(windows) != 1:
        raise RuntimeError('需要恰好一个可见的微信主窗口；请登录测试账号并关闭其他微信窗口')
    logger.info('已绑定微信主窗口：hwnd=%d', windows[0])

    uia = make_bound_uia(WeChatUIA, candidate_windows, windows)
    startup_stage('database')
    kwargs = {'account': w['account'], 'workdir': str(account_data(w['account']) / 'db')}
    if w.get('dbDir'):
        kwargs['db_dir'] = w['dbDir']
    db = WeChatDB(**kwargs)
    if db.account != w['account'] or db.wxid != w['botUserId']:
        raise RuntimeError('数据库账号与配置不一致，停止桥接')
    startup_stage('uia')
    prepare_uia(uia, candidate_windows, windows, w.get('enableAccessibility', False))
    startup_stage('baseline')
    startup_rows = read_startup_rows(db, groups)
    if check_connection:
        startup_stage('ready')
        logger.info('连接检查通过；未监听、调用模型、点击或发送消息。')
        lock.close()
        return
    state = load_state(w['account'])
    started_at = time.time()
    # Baseline each startup, including previously configured groups: never replay offline history.
    set_startup_watermarks(state, groups, startup_rows)
    save_state(state)
    startup_stage('ready')
    ready = os.environ.get('GAL_BRIDGE_READY')
    nonce = os.environ.get('GAL_BRIDGE_NONCE')
    if ready and nonce:
        Path(ready).write_text(json.dumps({'nonce': nonce, 'pid': os.getpid(), 'updatedAt': time.time()}), encoding='utf-8')
    session = requests.Session()
    session.trust_env = False
    logger.info('桥接已启动；只监听 %d 个白名单群。离线消息不会重放。', len(groups))
    while True:
        for group in groups:
            try:
                rows = db.get_messages(group, limit=200)
                pending = pending_rows(rows, state['groups'][group])
                if len(pending) == 200:
                    logger.warning('群消息超过读取窗口；可能丢失较早消息')
                for msg in pending:
                    if not pending_rows([msg], state['groups'][group]):
                        continue
                    # Persist before any HTTP or UI side effect. Failure stops the bridge.
                    advance_mark(state['groups'][group], msg)
                    save_state(state)
                    try:
                        # Database reads may initially return empty on transient failure.
                        # A wall-clock startup boundary prevents later history replay.
                        created = msg.get('create_time')
                        if not isinstance(created, (int, float)) or created <= started_at:
                            continue
                        event = event_for(db, group, msg, w['botUserId'])
                        if not event:
                            continue
                        add_group_context(event, db, rows, msg, w['botUserId'])
                        response = session.post(url, json=event, headers={'X-Bridge-Token': c['bridgeToken']}, timeout=(3, 120))
                        response.raise_for_status()
                        result = response.json()
                        if result.get('action') == 'reply' and isinstance(result.get('reply'), str) and result['reply'].strip():
                            if not pinned_window_present(candidate_windows, windows) or not win32gui.IsWindow(windows[0]):
                                raise RuntimeError('微信窗口发生变化')
                            send_once(db, uia, group, result['reply'])
                    except Exception as exc:
                        logger.error('消息处理失败，不重试：%s', message_error_reason(exc))
            except (OSError, ValueError):
                raise
            except Exception as exc:
                logger.error('读取群消息失败：%s', type(exc).__name__)
        time.sleep(0.5)


if __name__ == '__main__':
    start_parent_watchdog()
    try:
        if sys.argv[1:] == ['--check']:
            sys.exit(check_environment())
        elif sys.argv[1:] == ['--check-connection']:
            check_connection()
        elif sys.argv[1:]:
            print('Usage: wechat_bridge.py [--check | --check-connection]', file=sys.stderr)
            sys.exit(2)
        else:
            run()
    except KeyboardInterrupt:
        print('桥接已停止')
    except Exception as exc:
        reason = safe_reason(exc)
        startup_stage(CURRENT_STAGE, reason)
        print(f'桥接启动或运行失败：{reason}', file=sys.stderr)
        sys.exit(1)
