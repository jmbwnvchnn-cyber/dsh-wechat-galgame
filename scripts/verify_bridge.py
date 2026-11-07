import unittest
import logging
import tempfile
import sys
import types
from unittest.mock import Mock, patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge import wechat_bridge as bridge

class DB:
    def get_message_row(self, *args, **kwargs):
        return {'sender_username': 'user', 'source': '<msg><atuserlist>bot</atuserlist></msg>'}
    def get_nickname(self, sender): return sender

class BridgeTests(unittest.TestCase):
    def test_quoted_text_uses_fresh_title_and_real_mention(self):
        msg={'sender_username':'user','type':'文件/链接/卡片','local_id':1,'shard':'s',
             'content':'user:\n<msg><appmsg><type>57</type><title><![CDATA[@Bot\u2005你好]]></title><refermsg><content>/reset 旧内容</content></refermsg></appmsg></msg>'}
        self.assertEqual(bridge.event_for(DB(),'g',msg,'bot')['text'],'@Bot\u2005你好')
        msg['content']=msg['content'].replace('你好','/好感')
        self.assertEqual(bridge.event_for(DB(),'g',msg,'bot')['text'],'@Bot\u2005/好感')
        msg['content']=msg['content'].replace('/好感','/reset')
        self.assertIsNone(bridge.event_for(DB(),'g',msg,'bot'))
        msg['content']=msg['content'].replace('<type>57</type>','<type>5</type>')
        self.assertIsNone(bridge.event_for(DB(),'g',msg,'bot'),'link cards are not quoted text')
        msg['content']='not valid xml';self.assertIsNone(bridge.event_for(DB(),'g',msg,'bot'))
        class NotMentioned(DB):
            def get_message_row(self,*args,**kwargs):return {'sender_username':'user','source':'<msgsource />'}
        msg['content']='<msg><appmsg><type>57</type><title>@Bot\u2005你好</title><refermsg /></appmsg></msg>'
        self.assertIsNone(bridge.event_for(NotMentioned(),'g',msg,'bot'))

    def test_message_error_uses_only_fixed_reasons(self):
        self.assertEqual(bridge.message_error_reason(RuntimeError('发送结果不确定，不重试')), '发送结果不确定，不重试')
        self.assertEqual(bridge.message_error_reason(RuntimeError('secret-key pasted message')), 'RuntimeError')

    def test_group_context_is_recent_bounded_and_strips_sender_headers(self):
        import json
        event = {'chat_id':'g@chatroom','text':'文'*1900}
        current = {'local_id':20,'shard':'s','sort_seq':20,'create_time':1000}
        rows = [{'local_id':i,'shard':'s','sort_seq':i,'create_time':900+i,'type':'文本',
                 'sender_username':'user','content':'user:\n'+('讨论合作游戏'*60)} for i in range(1,10)]
        rows += [dict(rows[0],local_id=21,sort_seq=21),dict(rows[0],local_id=10,sort_seq=10,create_time=1),
                 dict(rows[0],local_id=11,sort_seq=11,content='user:\n@Bot\u2005/好感'),
                 dict(rows[0],local_id=12,sort_seq=12,type='图片')]
        bridge.add_group_context(event, DB(), rows, current, 'bot')
        self.assertGreater(len(event['group_context']),0)
        self.assertLessEqual(len(event['group_context']),8)
        self.assertLessEqual(len(json.dumps(event).encode('utf-8')),15000)
        self.assertTrue(all(item['chat_id']=='g@chatroom' and item['text'].startswith('讨论') and len(item['text'])<=240 for item in event['group_context']))

    def test_group_sender_prefix_removed_before_command_parsing(self):
        message = {'sender_username':'user', 'type':'文本', 'local_id':1, 'shard':'s',
                   'content':'user:\n@Bot\u2005/好感'}
        self.assertEqual(bridge.event_for(DB(), 'g', message, 'bot')['text'], '@Bot\u2005/好感')
        message['content'] = 'user:\n@Bot\u2005/reset'
        self.assertIsNone(bridge.event_for(DB(), 'g', message, 'bot'))
        message['content'] = '别人的前缀:\n@Bot\u2005/好感'
        self.assertEqual(bridge.event_for(DB(), 'g', message, 'bot')['text'], message['content'])

    def test_send_reuses_current_chat_instead_of_searching_it_again(self):
        db = types.SimpleNamespace(get_nickname=lambda group:'Unique group',
             search_contact=lambda title:[{'username':'g@chatroom','nick_name':title}])
        uia = types.SimpleNamespace(ensure_window=Mock(return_value=True),
              _win=types.SimpleNamespace(NativeWindowHandle=42), _force_foreground=Mock(return_value=True),
              current_chat=Mock(return_value='Unique group'),
              open_chat=Mock(side_effect=AssertionError('already in target chat')),
              send_text=Mock(return_value=True))
        bridge.send_once(db, uia, 'g@chatroom', 'reply')
        uia.open_chat.assert_not_called()
        uia._force_foreground.assert_called_once_with(42)
        uia.send_text.assert_called_once_with('reply')

    def test_compressed_wechat_mention_metadata_uses_existing_decoder(self):
        import zstandard
        source = zstandard.ZstdCompressor().compress(b'<msgsource><atuserlist><![CDATA[other,bot]]></atuserlist></msgsource>')
        class CompressedDB(DB):
            def get_message_row(self, *args, **kwargs):
                return {'sender_username':'user', 'source':source}
        message = {'sender_username':'user', 'type':'文本', 'local_id':1, 'shard':'s', 'content':'@Bot\u2005你好'}
        self.assertTrue(bridge.mentions_self(source, 'bot'))
        self.assertFalse(bridge.mentions_self(source, 'bo'))
        self.assertFalse(bridge.mentions_self(b'\x28\xb5\x2f\xfdbroken', 'bot'))
        self.assertIsNotNone(bridge.event_for(CompressedDB(), 'g', message, 'bot'))

    def test_candidate_windows_excludes_browser_titles_and_hidden_windows(self):
        titles = {1:'微信', 2:'微信 - DeepSeek - Edge', 3:'Weixin', 4:'微信'}
        names = {1:'Weixin.exe', 2:'msedge.exe', 3:'WeChat.exe', 4:'Weixin.exe'}
        gui = types.SimpleNamespace(GetWindowText=titles.get, IsWindowVisible=lambda h: h != 4,
              EnumWindows=lambda callback, unused: [callback(h, None) for h in titles])
        modules = {'win32gui':gui,
                   'win32process':types.SimpleNamespace(GetWindowThreadProcessId=lambda h: (0,h)),
                   'psutil':types.SimpleNamespace(Process=lambda pid: types.SimpleNamespace(name=lambda: names[pid])),
                   'wechatauto.uia_driver':types.SimpleNamespace(_title_is_main=lambda title: '微信' in title or 'Weixin' in title)}
        with patch.dict(sys.modules, modules):
            self.assertEqual(bridge.candidate_wechat_windows(), [1,3])

    def test_bounded_same_window_chat_proof(self):
        def node(aid='', cls='', hwnd=0, children=()):
            return types.SimpleNamespace(AutomationId=aid, ClassName=cls, NativeWindowHandle=hwnd, GetChildren=lambda: list(children))
        chat = [node('MainView.session_list'), node('MainView.main_tabbar')]
        root = node(cls='Qt51514QWindowIcon', hwnd=42, children=chat)
        self.assertTrue(bridge.has_chat_ui(root, 42))
        self.assertFalse(bridge.has_chat_ui(root, 43))
        self.assertFalse(bridge.has_chat_ui(node(cls='Qt51514QWindowIcon', hwnd=42), 42))
        self.assertFalse(bridge.has_chat_ui(node(cls='mmui::MainWindow', hwnd=42), 42))
        self.assertTrue(bridge.has_chat_ui(node(cls='mmui::MainWindow', hwnd=42, children=chat), 42))
        self.assertFalse(bridge.has_chat_ui(node(cls='mmui::LoginWindow', hwnd=42, children=chat), 42))
        self.assertFalse(bridge.has_chat_ui(node(cls='Qt51514QWindowIcon', hwnd=42, children=[node(cls='mmui::LoginView')] + chat), 42))
        self.assertFalse(bridge.has_chat_ui(root, 42, max_nodes=2))
        self.assertFalse(bridge.has_chat_ui(root, 42, max_depth=0))
        self.assertFalse(bridge.has_chat_ui(node(cls='OtherWindow', hwnd=42, children=chat), 42))
        fabricated = node('MainView.main_tabbar.session_list.some_label', cls='Text')
        self.assertFalse(bridge.has_chat_ui(node(cls='Qt51514QWindowIcon', hwnd=42, children=[fabricated]), 42))
        self.assertFalse(bridge.has_chat_ui(node('main_tabbar', cls='Qt51514QWindowIcon', hwnd=42, children=[node('session_list')]), 42), 'the root cannot supply an anchor role')
        self.assertFalse(bridge.has_chat_ui(node(cls='Qt51514QWindowIcon', hwnd=42, children=[node('session_list', cls='mmui::MainTabBar')]), 42), 'one node cannot prove two roles')
        self.assertTrue(bridge.has_chat_ui(node(cls='Qt51514QWindowIcon', hwnd=42, children=[node('MainView.chat_input_field'), node(cls='mmui::MainTabBar')]), 42))

    def test_large_chat_tree_accepts_independent_anchors_without_full_scan(self):
        def node(aid='', cls='', children=()):
            return types.SimpleNamespace(AutomationId=aid, ClassName=cls, NativeWindowHandle=42,
                                         GetChildren=lambda: list(children))
        large_branch = node(children=[node() for _ in range(700)])
        root = node(cls='mmui::MainWindow', children=[large_branch,
                    node('MainView.SESSION_LIST'), node('MainView.MAIN_TABBAR')])
        self.assertTrue(bridge.has_chat_ui(root, 42))
        self.assertFalse(bridge.has_chat_ui(root, 42, max_nodes=3))
        empty_large = node(cls='Qt51514QWindowIcon', children=[large_branch])
        self.assertEqual(bridge.inspect_chat_ui(empty_large, 42, max_nodes=10), 'blocked')

    def test_accessibility_verifier_waits_for_delayed_materialization(self):
        class Gate:
            active = False
            @staticmethod
            def _mmui_present(hwnd): return False
            @classmethod
            def _hot_activate_accessibility(cls, hwnd, verify=True):
                cls.active = True
                accepted = cls._mmui_present(hwnd)
                if not accepted: cls.active = False
                return accepted
        ticks, checks = [0.0], []
        def ensure():
            checks.append(ticks[0])
            return Gate.active and ticks[0] >= 0.4
        uia = types.SimpleNamespace(ensure_window=ensure, can_activate_accessibility=lambda: True)
        module = types.SimpleNamespace(AccessibilityGate=Gate)
        with patch.object(bridge, 'startup_stage'), \
             patch.object(bridge.time, 'monotonic', side_effect=lambda: ticks[0]), \
             patch.object(bridge.time, 'sleep', side_effect=lambda seconds: ticks.__setitem__(0, ticks[0] + seconds)):
            bridge.prepare_uia(uia, lambda: [42], [42], True, module)
        self.assertTrue(Gate.active)
        self.assertGreaterEqual(len(checks), 4)

    def test_bound_driver_does_not_scan_other_windows_or_wake(self):
        chat = types.SimpleNamespace(AutomationId='session_list', ClassName='', GetChildren=lambda: [])
        tab = types.SimpleNamespace(AutomationId='x.main_tabbar', ClassName='', GetChildren=lambda: [])
        root = types.SimpleNamespace(AutomationId='', ClassName='Qt51514QWindowIcon', NativeWindowHandle=42, GetChildren=lambda: [chat, tab])
        windows = [42]
        class Base:
            def _anchor(self, hwnd):
                self.anchored = hwnd
                return root
            def _find_main(self): raise AssertionError('must not scan')
            def _wake_accessibility(self): raise AssertionError('must not wake')
        uia = bridge.make_bound_uia(Base, lambda: windows[:], [42])
        self.assertTrue(uia.ensure_window())
        self.assertEqual(uia.anchored, 42)
        windows.append(43)
        self.assertTrue(uia.ensure_window(), 'other windows must not invalidate the already pinned account window')
        self.assertEqual(uia.anchored,42,'never switch to the newly opened window')
        windows[:]=[43]
        self.assertFalse(uia.ensure_window(),'a missing original window must not be replaced implicitly')
        windows[:] = [42]
        root.NativeWindowHandle = 43
        self.assertFalse(uia.ensure_window())

    def test_accessibility_requires_opt_in_and_verifies_with_rollback(self):
        class Gate:
            flag, calls, accept = 0, 0, False
            @staticmethod
            def _mmui_present(hwnd): return False
            @classmethod
            def _hot_activate_accessibility(cls, hwnd, verify=True):
                self.assertTrue(verify)
                cls.calls += 1
                original = cls.flag
                cls.flag = 1
                if cls._mmui_present(hwnd): return True
                cls.flag = original  # Simulates the dependency's candidate rollback.
                return False
        module = types.SimpleNamespace(AccessibilityGate=Gate, GATE_CACHE_FILE='outside')
        uia = types.SimpleNamespace(ensure_window=lambda: Gate.flag == 1 and Gate.accept, can_activate_accessibility=lambda: True)
        original = Gate.__dict__['_mmui_present']
        with patch.object(bridge, 'startup_stage'):
            with self.assertRaisesRegex(RuntimeError, 'UIA未启用'):
                bridge.prepare_uia(uia, lambda: [42], [42], gate_module=module)
            self.assertEqual(Gate.calls, 0)
            with self.assertRaisesRegex(RuntimeError, '控件核验未通过'):
                bridge.prepare_uia(uia, lambda: [42], [42], True, module)
            self.assertEqual(Gate.flag, 0)
            self.assertIs(Gate.__dict__['_mmui_present'], original)
            def racing_candidates():
                if Gate.flag == 1:
                    raise OSError('synthetic enumeration race after candidate write')
                return [42]
            with self.assertRaisesRegex(RuntimeError, '控件核验未通过'):
                bridge.prepare_uia(uia, racing_candidates, [42], True, module)
            self.assertEqual(Gate.flag, 0, 'verifier exceptions must become False so the dependency rolls back')
            self.assertIs(Gate.__dict__['_mmui_present'], original)
            Gate.accept = True
            bridge.prepare_uia(uia, lambda: [42], [42], True, module)
            self.assertEqual(Gate.calls, 3)
            self.assertEqual(module.GATE_CACHE_FILE, str(bridge.DATA / 'accessibility-gate.json'))
            bridge.prepare_uia(uia, lambda: [42], [42], True, module)
            self.assertEqual(Gate.calls, 3, 'a ready driver never reactivates')
            Gate.flag = 0
            with self.assertRaisesRegex(RuntimeError, '恰好一个'):
                bridge.prepare_uia(uia, lambda: [43], [42], True, module)
            self.assertEqual(Gate.calls, 3)

    def test_login_unknown_and_truncated_inventory_never_activate(self):
        def node(cls, children=()):
            return types.SimpleNamespace(ClassName=cls, AutomationId='', NativeWindowHandle=42, GetChildren=lambda: list(children))
        roots = [node('mmui::LoginWindow'), node('Qt51514QWindowIcon', [node('mmui::LoginView')]),
                 node('OtherWindow'), node('Qt51514QWindowIcon', [node('Text') for _ in range(6001)]),
                 node('mmui::MainWindow'), node('Qt51514QWindowIcon', [node('mmui::SettingsView')])]
        single_anchor = node('Text')
        single_anchor.AutomationId = 'MainView.session_list'
        roots.append(node('Qt51514QWindowIcon', [single_anchor]))
        gate = types.SimpleNamespace(_hot_activate_accessibility=Mock(side_effect=AssertionError('must not activate')))
        module = types.SimpleNamespace(AccessibilityGate=gate)
        for root in roots:
            class Base:
                def _anchor(self, hwnd): return root
            uia = bridge.make_bound_uia(Base, lambda: [42], [42])
            self.assertFalse(uia.can_activate_accessibility())
            with self.assertRaisesRegex(RuntimeError, '安全核验'):
                bridge.prepare_uia(uia, lambda: [42], [42], True, module)
        gate._hot_activate_accessibility.assert_not_called()
        root = node('Qt51514QWindowIcon')
        self.assertTrue(bridge.make_bound_uia(Base, lambda: [42], [42]).can_activate_accessibility())

    def test_connection_check_deadline_cancels_or_exits_with_fixed_stage(self):
        with patch.object(bridge.threading, 'Timer') as timer, patch.object(bridge, 'run') as run, \
             patch.object(bridge, 'startup_stage') as stage, patch.object(bridge.os, '_exit') as terminate, \
             patch.object(bridge.sys, 'stderr', new=Mock()):
            bridge.check_connection(timeout=0.01)
            run.assert_called_once_with(check_connection=True)
            timer.return_value.start.assert_called_once()
            timer.return_value.cancel.assert_called_once()
            expire = timer.call_args.args[1]
            expire()
            terminate.assert_called_once_with(124)
            self.assertIn('连接检查启动超时', stage.call_args.args[1])

    def test_progress_identity_and_safe_errors(self):
        import json
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent.parent) as temp:
            progress = Path(temp) / 'progress.json'
            with patch.object(bridge, 'setup_bridge_logger', return_value=Mock()), patch.dict('os.environ', {'GAL_BRIDGE_PROGRESS':str(progress), 'GAL_BRIDGE_NONCE':'synthetic-nonce'}):
                bridge.startup_stage('imports')
                result = json.loads(progress.read_text(encoding='utf-8'))
                self.assertEqual(result['nonce'], 'synthetic-nonce')
                self.assertEqual(result['pid'], bridge.os.getpid())
                self.assertEqual(result['stage'], 'imports')
                reason = bridge.safe_reason(Exception('secret-key DLL load failure'))
                self.assertNotIn('secret-key', reason)
                self.assertIn('DLL', reason)
                bridge.startup_stage('imports', reason)
                self.assertEqual(json.loads(progress.read_text(encoding='utf-8'))['error'], reason)

    def test_connection_check_returns_before_polling_or_watermark_writes(self):
        settings = {'bridgeToken':'synthetic'}
        options = {'account':'synthetic', 'botUserId':'bot'}
        db = types.SimpleNamespace(account='synthetic', wxid='bot')
        requests = types.SimpleNamespace(Session=Mock(side_effect=AssertionError('no HTTP')))
        gui = types.SimpleNamespace(GetWindowText=lambda hwnd: '微信', IsWindowVisible=lambda hwnd: True,
                                    EnumWindows=lambda callback, unused: callback(42, None))
        replica = types.SimpleNamespace(WeChatDB=Mock(return_value=db), WxParam=types.SimpleNamespace())
        modules = {'requests':requests, 'win32gui':gui, 'wechatauto':replica,
                   'win32process':types.SimpleNamespace(GetWindowThreadProcessId=lambda h: (0,1)),
                   'psutil':types.SimpleNamespace(Process=lambda pid: types.SimpleNamespace(name=lambda: 'Weixin.exe')),
                   'wechatauto.uia_driver':types.SimpleNamespace(WeChatUIA=object, _title_is_main=lambda title: title == '微信'),
                   'msvcrt':types.SimpleNamespace(locking=lambda *args: None, LK_NBLCK=1)}
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent.parent) as temp, \
             patch.dict(sys.modules, modules), patch.object(bridge, 'DATA', Path(temp)), \
             patch.object(bridge, 'config', return_value=(settings, options, ['g'], 'http://unused')), \
             patch.object(bridge, 'startup_stage'), patch.object(bridge, 'setup_bridge_logger', return_value=Mock()), \
             patch.object(bridge, 'make_bound_uia', return_value=types.SimpleNamespace(ensure_window=lambda: True)), \
             patch.object(bridge, 'read_startup_rows', return_value={'g':[]}), \
             patch.object(bridge, 'save_state') as save, patch.object(bridge, 'load_state') as load:
            bridge.run(check_connection=True)
            save.assert_not_called()
            load.assert_not_called()
            requests.Session.assert_not_called()

    def test_mentioned_command_ignored(self):
        msg = {'sender_username': 'user', 'type': '文本', 'local_id': 1, 'shard': 's', 'content': '@Bot\u2005/reset'}
        self.assertIsNone(bridge.event_for(DB(), 'g', msg, 'bot'))
        for text in (' @Bot\u2005/reset', '@Alice\u2005@Bot\u2005/reset'):
            msg['content'] = text
            self.assertIsNone(bridge.event_for(DB(), 'g', msg, 'bot'))
        for text in ('@Bot\u2005/好感', '@Bot\u2005/事件', '@Bot\u2005/选择 A', '@Alice\u2005@Bot\u2005/记住 我喜欢草莓', '/忘记 全部'):
            msg['content'] = text
            self.assertIsNotNone(bridge.event_for(DB(), 'g', msg, 'bot'))
        msg['content'] = '@Bot\u2005你好'
        self.assertEqual(bridge.event_for(DB(), 'g', msg, 'bot')['text'], '@Bot\u2005你好')
    def test_logger_survives_root_handler_reset(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent.parent) as temp:
            old_data = bridge.DATA
            bridge.DATA = Path(temp)
            logger = bridge.setup_bridge_logger()
            try:
                logging.getLogger().handlers.clear()
                logger.info('synthetic bridge event')
                self.assertIn('synthetic bridge event', (Path(temp) / 'bridge.log').read_text(encoding='utf-8'))
            finally:
                for handler in logger.handlers[:]:
                    logger.removeHandler(handler)
                    handler.close()
                bridge.DATA = old_data
    def test_watermark_survives_reload(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent.parent) as temp:
            old_data, old_state = bridge.DATA, bridge.STATE
            bridge.DATA = Path(temp)
            bridge.STATE = Path(temp) / 'watermark.json'
            try:
                state = {'account': 'synthetic', 'groups': {'g': {'seq': 7, 'ids': ['s:1']}}}
                bridge.save_state(state)
                mark = bridge.load_state('synthetic')['groups']['g']
                self.assertEqual(len(bridge.pending_rows([{'sort_seq': 7, 'shard': 's', 'local_id': 2}], mark)), 1)
            finally:
                bridge.DATA = old_data
                bridge.STATE = old_state
    def test_equal_sequence_new_id_is_pending(self):
        mark = {'seq': 7, 'ids': ['s:1']}
        rows = [{'sort_seq': 7, 'shard': 's', 'local_id': 1}, {'sort_seq': 7, 'shard': 's', 'local_id': 2}]
        self.assertEqual(bridge.pending_rows(rows, mark), [rows[1]])
        bridge.advance_mark(mark, rows[1])
        self.assertEqual(bridge.pending_rows(rows, mark), [])

if __name__ == '__main__': unittest.main()


