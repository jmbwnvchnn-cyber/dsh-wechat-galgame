# 开发说明

## 环境

当前启动脚本固定查找 `runtime/node/node.exe`，设置向导固定查找 `runtime/python/python.exe`。从同版本 Releases 的便携包复制完整 `runtime/` 到源码根目录后，使用 `start-service.bat` 即可。

安装系统 Node.js 22+ 后，也可先运行 `node scripts/init-config.js`，再运行 `node server.js`，手动打开 `http://127.0.0.1:3000/setup.html`。但检测微信账号、搜索群和启动桥接仍需要上述 Python 运行环境目录；不能仅靠系统 `python` 代替。

源码不包含本机配置、角色存档、微信数据库或运行时。首次运行生成默认角色“小鲸”，可以在管理台自行修改。

## 目录

- `server.js`：本机 HTTP 服务。
- `src/`：配置、角色、记忆、模型请求、计分、事件和设置向导逻辑。
- `web/`：管理台和设置页。
- `bridge/`：微信消息读取和回复桥接。
- `scripts/`：启动、停止、配置、打包及现有检查脚本。
- `docs/`：玩法、桥接、接口和隐私说明。

## 检查

Node.js 检查脚本使用模拟消息/接口。可逐个运行 `scripts/verify*.js`；Python 检查可用 `python -m unittest discover -s scripts -p "verify_*.py"`，需要 Python 3.12。PowerShell 的 `verify_launcher.ps1` 和 `verify_stop.ps1` 使用模拟进程检查启动/停止控制流。

这些检查不证明某个微信客户端版本可用。真实联调请另行使用自己的测试账号和获准群聊，注意模型调用费用。

## 重新打包

先补齐 `runtime/`，再运行 `scripts/build-share.bat`。脚本使用文件白名单生成 `release/gal-portable.zip`，排除 `config.json` 和 `data/`，保留 LICENSE 与第三方声明。脚本会核对本机凭据是否出现在包内的相关文本中；发布前仍要检查运行时内的第三方文件和许可。

修改后请注明版本并使用新的解压目录试用，不要把个人运行目录直接提交。

## 维护状态

这是现有实验版本的公开整理，暂不承诺持续开发、答复时限、安装服务或新版本兼容。提交改进时请说明问题、修改和验证方法，不附私人聊天或凭据。
