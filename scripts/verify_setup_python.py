import hashlib
import importlib.util
import sqlite3
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

probe = load('probe', ROOT / 'scripts' / 'setup_probe.py')
bridge = load('bridge', ROOT / 'bridge' / 'wechat_bridge.py')

class DB:
    _db_files = [('contact', 'contact.db', 1)]
    def __init__(self, contact=True, fail=False):
        self.contact, self.fail = contact, fail
    def _message_dbs(self):
        return ['shard']
    def _shard_label(self, conn):
        return 'shard.db'
    def _open(self, rel):
        if self.fail:
            raise sqlite3.DatabaseError('unreadable')
        conn = sqlite3.connect(':memory:')
        conn.execute('create table contact(username text)')
        if self.contact:
            conn.execute("insert into contact values ('wxid_a')")
        if getattr(self, 'populated', False):
            table = 'Msg_' + hashlib.md5(b'group@chatroom').hexdigest()
            conn.execute(f'create table "{table}" (local_id integer, local_type integer, real_sender_id integer, create_time integer, message_content text, source text, packed_info_data blob, compress_content blob, server_id integer, sort_seq integer)')
            conn.execute(f'insert into "{table}" values (7, 1, 1, 1, null, null, null, null, 1, 42)')
        if getattr(self, 'bad_table', False):
            table = 'Msg_' + hashlib.md5(b'group@chatroom').hexdigest()
            conn.execute(f'create table "{table}" (local_id integer)')
        return conn

class Verification(unittest.TestCase):
    def test_account_watermarks_and_legacy_adoption(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            old_data, old_state = bridge.DATA, bridge.STATE
            bridge.DATA = Path(temp)
            bridge.STATE = Path(temp) / 'watermark.json'
            try:
                legacy = {'account': 'A', 'groups': {'g': {'seq': 9, 'ids': ['s:1']}}}
                bridge.STATE.write_text(json.dumps(legacy), encoding='utf-8')
                original = bridge.STATE.read_bytes()
                self.assertEqual(bridge.load_state('B'), {'account': 'B', 'groups': {}})
                self.assertFalse((bridge.account_data('B') / 'watermark.json').exists())
                self.assertEqual(bridge.STATE.read_bytes(), original)
                self.assertEqual(bridge.load_state('A'), legacy)
                self.assertTrue((bridge.account_data('A') / 'watermark.json').exists())
                state_b = {'account': 'B', 'groups': {'g': {'seq': 21, 'ids': ['s:4']}}}
                bridge.save_state(state_b)
                self.assertEqual(bridge.load_state('B'), state_b)
                self.assertEqual(bridge.load_state('A'), legacy)
                self.assertEqual(bridge.STATE.read_bytes(), original)
                self.assertNotEqual(bridge.account_data('A') / 'db', bridge.account_data('B') / 'db')
                self.assertEqual(bridge.account_data('../A').parent, Path(temp) / 'accounts')
                # Existing account files take priority over an outdated legacy cursor.
                bridge.STATE.write_text(json.dumps({'account': 'A', 'groups': {'g': 1}}), encoding='utf-8')
                self.assertEqual(bridge.load_state('A'), legacy)
                (bridge.account_data('B') / 'watermark.json').write_text(json.dumps({'account': 'B', 'groups': {'g': -1}}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    bridge.load_state('B')
            finally:
                bridge.DATA, bridge.STATE = old_data, old_state

    @unittest.skipUnless(os.name == 'nt', 'Windows CRT/native import regression')
    def test_managed_watchdog_does_not_block_native_import(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            marker = Path(temp) / 'imported'
            script = (
                "import runpy,time; from pathlib import Path; "
                f"m=runpy.run_path({str(ROOT / 'bridge/wechat_bridge.py')!r}); "
                "m['start_parent_watchdog'](); import numpy; "
                f"Path({str(marker)!r}).write_text('ok'); time.sleep(60)"
            )
            child = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     env=dict(os.environ, GAL_BRIDGE_MANAGED='1'))
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and child.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(marker.exists(), 'native import must finish while the parent pipe stays open')
                child.stdin.close()
                self.assertEqual(child.wait(timeout=3), 0)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=3)
                if not child.stdin.closed:
                    child.stdin.close()

    def test_managed_child_exits_on_parent_pipe_eof(self):
        # Import only our standard-library bridge module; never run its WeChat
        # entry point. A blocking sleep stands in for startup or an HTTP wait.
        script = (
            "import importlib.util,time; "
            f"s=importlib.util.spec_from_file_location('bridge', {str(ROOT / 'bridge' / 'wechat_bridge.py')!r}); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "m.start_parent_watchdog(); print('ready',flush=True); "
            "time.sleep(60); print('unexpected',flush=True)"
        )
        env = dict(os.environ, GAL_BRIDGE_MANAGED='1')
        child = subprocess.Popen([sys.executable, '-u', '-c', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\r\n' if os.name == 'nt' else b'ready\n')
            self.assertIsNone(child.poll(), 'a live parent pipe keeps the managed child alive')
            child.stdin.close()
            self.assertEqual(child.wait(timeout=3), 0, 'EOF must interrupt a blocked managed child promptly')
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()
        env.pop('GAL_BRIDGE_MANAGED', None)
        standalone = script.replace('time.sleep(60)', 'time.sleep(0.1)').replace("print('unexpected',flush=True)", "print('standalone',flush=True)")
        result = subprocess.run([sys.executable, '-u', '-c', standalone], stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'standalone', result.stdout, 'standalone diagnostics must not depend on stdin')

    def test_identity_requires_row(self):
        self.assertTrue(probe.verify_identity(DB(), 'wxid_a'))
        self.assertFalse(probe.verify_identity(DB(contact=False), 'wxid_a'))
    def test_shard_failure_and_empty_group(self):
        self.assertEqual(bridge.read_startup_rows(DB(), ['group@chatroom']), {'group@chatroom': []})
        populated = DB(); populated.populated = True
        rows = bridge.read_startup_rows(populated, ['group@chatroom'])
        self.assertEqual(rows['group@chatroom'], [{'local_id': 7, 'sort_seq': 42, 'shard': 'shard.db'}])
        state = {'groups': {}}
        bridge.set_startup_watermarks(state, ['group@chatroom'], rows)
        self.assertEqual(state['groups']['group@chatroom'], {'seq': 42, 'ids': ['shard.db:7']})
        broken = DB(); broken.bad_table = True
        with self.assertRaises(sqlite3.DatabaseError):
            bridge.read_startup_rows(broken, ['group@chatroom'])
        with self.assertRaises(sqlite3.DatabaseError):
            bridge.read_startup_rows(DB(fail=True), ['group@chatroom'])

if __name__ == '__main__':
    unittest.main()
