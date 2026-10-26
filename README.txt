LQ 燕云 Logs 0.4.1
================

Windows 独立客户端：手动选择燕云进程后采集，实时悬浮统计，保存捕获记录用于复盘；也可单独导入游戏本地 CLv2 日志。

启动客户端不会绑定游戏或开始抓包。用户需要先启动游戏，再刷新进程列表、选择进程并点击“绑定并开始采集”。PID 与启动时间共同校验；游戏重启后必须重新选择。

功能
- 网络捕获：只读连接状态初始化、版本校验、被动 TCP 捕获、连续性校验、协议解析。
- 复盘：队伍服务器累计值、技能结算、逐次伤害/治疗通知、Buff 观测、战斗边界，按角色和编号筛选及分页。
- 保存完整会话、原始捕获、解码事件和识别出的战斗段；导入已有 capture 目录不改写原始记录。
- 本地 CLv2：文件/压缩包导入、手动扫描、技能阶段、Buff 覆盖、笔记和多视角合并。
- Kagerou 衍生悬浮窗：输出、治疗、承伤字段；透明度、字体、置顶及鼠标穿透。
- 名称沿用本机游戏配置生成的映射；找不到映射时保留编号，不猜测名称。

数据含义
服务器累计值、逐次通知与技能结算是独立视图，不能相加。网络时间为本机接收时间。只有已验证的战斗时长才用于每秒统计。队友私有 Buff、完整施法顺序、完整覆盖和 rDPS 尚未验证。已发现缺包或连接改变时停止当前解码，保留缺口说明。

组织
desktop/                 Electron 窗口、手动绑定、子进程生命周期
collector/tools/         本地采集、协议解析和归档
engine/                  CLv2 解析、网络记录索引与本机接口
engine/web/              客户端复盘界面
vendor/kagerou/yanyun/   燕云专用悬浮界面（Git 子模块）
tests/、engine/tests/    数据一致性及生命周期测试
tools/                   构建和本地依赖准备

Kagerou 上游源码仍在子模块中便于追溯，发行包仅允许 yanyun/ 和许可文件进入。FF14 职业、宠物合并、ACT 连接、直击/暴击及原版设置页不在运行入口和发行包中。

开发与构建（Windows）
1. git clone --recurse-submodules https://github.com/Liquidzk/LQ-yysls-logs.git
2. 安装 Node.js 22.12+（建议 Node.js 24）、Python 3.10+，运行 npm ci。
3. 为 Python 安装 pyinstaller。
4. node tools/prepare-collector.cjs <本机参考客户端的 resources 目录>
   仅复制列明的运行时、协议描述与属性映射，不复制原始会话、样本战斗或连接密钥。
   Npcap 驱动由用户自行安装；本项目不会自动安装驱动或提升权限。
5. 本机生成的名称映射放入 engine/name_catalog.json。该文件不提交仓库；缺失时以编号显示。
6. powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-engine.ps1 -Python <Python 路径>
7. npm run package
8. 输出 release/v0.4.1/LQ-yysls-logs-win32-x64/燕云Logs.exe；完整目录一起使用。

开发运行：先构建解析引擎、准备采集资源，再 npm start。
可在根目录创建 desktop.local.json 指定 dataDir 和 logRoot；该配置只保存在本机。
无本地配置时，数据默认位于用户的 LQ 燕云 Logs 应用数据目录。

验证
npm test
在 engine 目录运行 python -m unittest discover -s tests -v
node tests/collector-e2e.cjs
node tests/collector-e2e.cjs --current-build
node tests/collector-e2e.cjs --current-build --cached-only
以上端到端验证使用合成消息和实际协议解码器，覆盖旧版、当前版本及仅有缓存名字的会话；完全离线，不选择游戏进程、不打开抓包网卡。
可用 --validation-data <独立目录> 启动客户端进行隔离验收，不影响原有战斗库。

采集兼容配置目前锁定经过校验的客户端映像；游戏更新导致校验失败时需要重新分析并更新配置，不绕过校验。
新一版已通过离线解码和客户端验收；实际在线采集需用户手动选择进程后验证。

许可
GPL-3.0-or-later，见 COPYING。
悬浮界面源于 Kagerou，子模块保留原始许可与作者声明。
采集辅助代码改编自用户提供的 YyslsLogs 0.2.1 GPL 发行版，详见 collector/NOTICE.txt。
runtime/、release/、游戏名称表、协议资产、原始战斗、个人配置和连接状态均不提交源代码仓库。

完整操作说明见 docs/客户端使用说明.txt。
