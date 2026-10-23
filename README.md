# Session Stats

Codex++ tweak，在当前会话输入框底部显示：

```text
2 turns · 33 steps · 209 tok/s     11.7M tok · Cache hit 96%
```

不显示上下文占用。统计行居中放在输入框下方已有的留白内，不占布局高度、不把输入框往上顶。
适配浅色、深色主题，窄窗口可横向滚动；鼠标停在指标上可查看口径。

支持本地及 Codex 已连接的远程主机会话，包括 Remote Control 主机。远程统计直接读取目标主机的
会话日志，使用同一套指标口径；不需要在远端安装额外脚本。远端必须支持 Codex 的
`thread/read`、`fs/getMetadata` 和 `fs/readFile` 接口，并能访问该会话的 rollout 日志。

## 指标口径

| 指标 | 计算方式 |
| --- | --- |
| turns | 当前有效日志历史中不同 `turn_id` 的数量 |
| steps | 不同 `response_id` 的模型响应数量，不是工具调用次数 |
| tok/s | 当前轮所有响应的官方 `usage.output_tokens`（包含推理）÷ 模型活跃秒数 |
| tok | 普通会话使用官方累计 Token；本地分叉会话仅累计分叉后每次响应的用量。输入 + 输出，缓存输入不重复相加 |
| Cache hit | 累计缓存输入 Token ÷ 累计输入 Token |

模型活跃时间取 `item_completed` 中 `Reasoning` 和 `AgentMessage` 的
`started_at_ms` / `completed_at_ms` 区间并集，重叠时间只算一次，排除工具执行、I/O 和用户等待。
TPS 在响应完成后更新，`~` 表示新用量尚未到达时保留上次有效值。进入新轮清空旧轮速度。
缺少完整用量、模型计时、轮次起点或有效时长时显示 `—`，不会通过字符数估算 Token。
开始与结束时间相同的记录贡献 0 毫秒，不会让同轮其他有效计时失效；全轮不足 100 毫秒仍显示 `—`。

这是依据客户端日志计算的本轮平均模型速度，包含模型处理阶段的开销，不是服务端测得的纯解码速度。
旧日志可能只有累计 Token，而没有 steps 或 TPS 所需字段；截断或压缩的历史也以可读日志为准。
本地分页分叉会话只统计分叉后的轮次、steps、Token、缓存命中率和 TPS，不读取父会话历史。
当前分支自身的续接日志仍会合并；缺少单次响应用量时，相应累计指标显示 `—`，不回退到包含父历史的累计值。

TPS 思路参考 [dongyue-19/codex-statusbar](https://github.com/dongyue-19/codex-statusbar)
的 `TpsTracker.cs`，本项目独立实现。

## 安装

在 Codex++ Settings → Tweak Store 中搜索 **Session Stats** 并安装，最低运行时版本为 `1.0.6`。
Store 固定到审核过的完整提交 SHA；安装后无需运行 `npm install` 或构建。

源码：[kpkhxlgy0/session-stats](https://github.com/kpkhxlgy0/session-stats)。
版本：[v0.1.7](https://github.com/kpkhxlgy0/session-stats/releases/tag/v0.1.7)。

## 本地 Inject / Uninject

已安装 Codex++ 时，可在源码目录用 PowerShell 7 执行：

```powershell
pwsh -File .\Inject-CodexPlusPlus.ps1
pwsh -File .\Uninject-CodexPlusPlus.ps1
```

两者都支持 `-CheckOnly`，只查看将执行的操作。脚本使用 `CODEX_PLUSPLUS_HOME`，
未设置时使用 `%APPDATA%\codex-plusplus`。

Inject 创建指向本目录的开发链接并启用 Session Stats，重复执行安全。
Uninject 禁用此 tweak，并移除指向本目录的开发链接，保留源码。
如果已从 Store 安装，脚本仅启用或禁用该副本，不替换或删除它。
脚本不会安装、升级或卸载 Codex++，也不影响其他 tweak。

## 开发与验证

需要同级目录中的规范 Codex++ checkout `../codex-plusplus`，已构建且版本不低于 `1.0.6`。

```powershell
git clone https://github.com/kpkhxlgy0/session-stats.git
cd session-stats
npm ci
npm test
npm run validate
npm run install:local
```

安装通过规范仓库提供的开发链接命令，将 `%APPDATA%\codex-plusplus\tweaks\com.kpk.session-stats`
链接到当前源码目录；运行时自动热重载。没有后台安装脚本、常驻开发进程或运行时 npm 依赖。
可在 Codex++ Tweaks 管理界面禁用 Session Stats。禁用会移除统计条、监听器、定时器及本 tweak 的 IPC。

测试也可独立运行，只需 Node.js 20 或更高版本；`validate` 和 `install:local` 才需要同级 Codex++ checkout。
已在 Windows 的 Codex 桌面端验证实际加载；其他平台的原生界面尚未实测。

## 数据与兼容性

- 本地会话增量读取 `$CODEX_HOME/sessions` 和 `archived_sessions`；未设置时使用 `~/.codex`。
  支持带 `_UUID` 后缀的续接日志，每 15 秒重新发现续接文件。按 `session_meta.history_base` 的
  字节位置与记录数边界读取唯一匹配的旧日志前缀，再读取续接记录；被替换的旧尾部不参与统计。
  响应按 `response_id` 去重，普通会话使用官方累计值，不对各日志的累计值求和。
  分叉会话在已确认的分叉边界停止回溯，并按唯一响应累计本分支用量；父历史缺失或压缩不影响统计。
  归档同名副本不会重复读取；当前分支缺失历史、边界不完整或来源无法唯一确认时显示 `—`。
- 远程会话通过 Codex 已有的主机连接读取 `thread/read` 返回的日志路径，不会查找本机同名会话。
  兼容会话 ID 后带单个 `_UUID` 后缀的日志文件名；路径文件名、返回的会话 ID 和日志内的会话元数据都必须匹配。
- 日志保持只读，不修改远程文件、不运行远程命令，也不向第三方上传数据。
  远程日志通过应用的主页面桥接传给本地统计器；不落盘、不写入运行日志。底栏只接收指标和会话标识。
- 支持完整行追加、拆分 UTF-8、文件截断或替换、同一会话并发读取去重，以及负查询缓存。
- 根据当前输入框的主机 ID 和会话 ID 共同绑定，跳过首页、云端任务和无法唯一识别的输入框。
- Codex 开启 Electron 隔离环境时，主进程在调用方主页面执行固定的只读标识查询脚本，
  仅返回输入框标记、会话 ID 和主机 ID。脚本不接收外部代码，也不跨环境传递 React 对象或聊天内容。
- 输入框及 React 属性属于 Codex 内部实现，未来应用更新可能需要调整 `src/binding.cjs`；
  无法绑定时隐藏统计条，不猜测当前会话。
- 页面可见时约每秒刷新底栏；本地日志增量读取，远程请求至少间隔 15 秒。
  远程日志超过 4 MiB 时改为至少 60 秒；路径及文件时间未变时不重复下载。同一会话的并发请求合并。
  当前远程接口只确认支持整文件读取，因此日志超过 32 MiB 时暂不提供统计；超时、断线、接口不支持
  或身份校验失败时显示 `—`，恢复后自动重试。远程统计会有相应刷新延迟。
- DOM 变化合并处理；运行日志仅记录启动和首次成功挂载的指标摘要。
- 远程桥接依赖 Codex 内部协议，已按 Windows 安装包 `26.1016.51333` 核对并做协议回归测试；
  已在 Windows 真实 Remote Control 会话确认统计恢复，其他平台的原生界面尚未实测。

## 文件

- `index.js`：主进程和渲染进程生命周期、IPC。
- `src/metrics.cjs`：用量去重、缓存命中率、模型时间并集和 TPS。
- `src/session-store.cjs`：会话文件发现、增量只读读取和缓存。
- `src/remote-session-store.cjs`：远程会话日志校验、快照统计和轮询缓存。
- `src/remote-transport.cjs`：现有主机连接的只读请求、分块响应和取消清理。
- `src/binding.cjs`：当前输入框会话绑定。
- `src/renderer.cjs`：统计条、会话切换和清理。
- `test/`：指标、文件轮换、隔离环境、切换会话和热重载回归测试。

## 许可

[MIT](LICENSE)
