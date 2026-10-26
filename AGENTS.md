# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-zhihu-scroll`（中文名「刷知乎」）：每天替用户刷一轮知乎 —— 按领域/来源/判断权重
捞候选、**读回答正文**判断、写月度文章，值得的留在卡片墙里。**不做任何互动**（不点赞/评论/关注/私信），
**登录只走传统 cURL / Cookie 导入**。

## 帮用户装时，按这个顺序

1. **确认 DSH 版本** ≥ `0.2.1-rc.2`（桌面版 0.2.1-rc.2 上验证过）。
2. **装插件**（本地目录或 tgz）：

   ```bash
   DSH="/path/to/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
   "$DSH" plugin --profile desktop add /绝对路径/dsh-zhihu-scroll
   # 或
   "$DSH" plugin --profile desktop add /绝对路径/dsh-zhihu-scroll-0.3.6.tgz
   ```

   - web profile 把 `desktop` 换成 `web`；
   - **本地目录会被 pnpm 链接**，别移动源目录；要分发用 tgz。

3. **必须提醒用户重启一次 DSH**（bundle 层要重启才组装）。
4. 重启后让用户进 **设置 → 刷知乎 → 账号**：
   - 传统方式：用户在浏览器登录 **www.zhihu.com** → `F12 → Network` →
     选一条 **Request URL 为 `https://www.zhihu.com`** 的请求（**无任何后缀**，页面本身的 Document 请求）→ `Copy as cURL` →
     回到设置页点「从剪贴板导入」（没权限就展开「手动粘贴」）；
     不要选带 `/api/...` 路径/查询参数的请求，也不要选 `zhihu.com` / `zhihu-web-analytics.zhihu.com` / `apm.zhihu.com` 等子域；
   - **不要**让用户把 Cookie 贴到聊天里；也不要建议扫码/短信/密码登录（这一版不做）；
   - 保存后点「测一下」，再看 **偏好** 调权重；
   - 手动跑就在对话里说「刷一轮知乎」；**定时**要先在自动值班里选一个专门刷知乎的对话、
     点「测试投递」确认能回 OK，再填精确时间点（`08:30, 12:30`）或开窗口，最后打开自动开关；
     时间点每天一次，错过 10 分钟内补跑；**DSH、目标对话都要开着，电脑不能睡**；
   - 数据目录在 **高级 → 数据目录** 可手动改；`POST /api/zhihu-duty/home {home}` 会复制旧数据、
     写指针并运行时切换（不需要重启）；`DSH_ZHIHU_HOME` 存在时禁用。
5. **不要替用户开自动值班**，也不要让用户把 Cookie 贴到聊天里。

## 排查顺序

1. `GET /api/zhihu-duty/status` 看 `auth.configured` / `today.lastError`；
2. `GET /api/zhihu-duty/diagnose`（或设置页「复制诊断信息」）—— 里面没有 Cookie 原文；
3. `$DSH_HOME/zhihu-duty/duty.log` 最后几十行；
4. 常见错误码：
   - `not_logged_in`（401）：Cookie 失效 / 没 `z_c0`；
   - `challenge`（403 + 验证页）：知乎风控，让用户回浏览器通过验证、等几分钟；
   - `network`：本机网络/代理；
   - 跑一轮报 `no API key`：DSH 模型凭证没配，去设置 → 模型；
   - 跑一轮报 `agents`：当前 profile 没挂 `dsh-agent`（桌面版正常有）；
   - 报 `messages[246]: missing field role`（422）：0.2.6 的 `parent.followup` 注入消息缺 `role`。
     0.3.0+ 定时投递已带完整 `role`/`id`，且只投用户选的目标对话；修坏对话的方法：
     在会话 zstd 里截到注入前的最后一个 `turn/end`，删掉 projcache，重启后重开。

## 仓库结构

- `index.js` —— 宿主半端：6 只工具、`/api/zhihu-duty/*`、窗口定时器（定时投递到目标对话）
- `client.js` —— 浏览器半端：设置页（`settings.section`，id `zhihu-scroll`），日常/偏好/账号/高级
- `lib/zhihu.mjs` —— Cookie 解析 / 请求 / 热榜（新 `title_area` 结构）/推荐/关注 / 正文 / 评论 / 关注列表 / 加权 collect
- `lib/domains.mjs` —— 16 个领域 + 来源/判断目录 + 权重匹配
- `lib/report.mjs` —— 月度文章 Markdown + 每日 JSON；合并、计数、卡片墙；`reportHistory` 提供同内容/30 天同问题/当日同作者索引；主条目带 `related`
- `lib/config.mjs` —— 配置默认值/迁移/清洗/窗口
- `lib/schedule.mjs` —— 精确时间点：归一化、下一次、到点/10 分钟补跑
- `lib/state.mjs` —— 数据目录指针、日志、状态、凭证、章程账本
- `lib/html.mjs` —— 富文本 → 纯文本
- `prompts/duty.md` —— 值班章程（用户可改；升级不覆盖改过的版本）
- `test/` —— `node:test` 测试（mock 知乎服务 + fake ctx）

## 约定

- 运行数据默认在 `$DSH_HOME/zhihu-duty/`，可在设置页改成别的目录；**不写进插件包目录**；
- 文章是**月度文件**，每天增量并入，最新一天在最前；`out/<日期>.md` 不再生成；
- 旧日期区块一旦写入就不再重写（`preserveOldMonthly`），只重写当天/新增日期；
- `perDay` 只用于自动调度/章程目标；`zhihu_report_save` **不按额度硬拦**，手动超额度也要继续并入；
- 定时支持精确时间点（`scheduleTimes`，HH:mm，最多 12 个）；留空才走旧的午间/夜间窗口；
- 候选目标 `max(candidates, 10×perDay)`，上限 200；`zhihu_feed` 支持 `page`；
- 去重：同内容（含 related）永久、同问题 30 天、同日同作者 1 条；`zhihu_report_save` 会跳过并返回 `skipped`；
- 工具参数 schema 只能使用 DSH 支持的 JSON Schema 子集：
  `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解；
  **别用** `minimum` / `maximum` / `maxItems`（宿主的 `assertSupportedJsonSchema` 会拒收，
  整条插件不激活），范围在描述里写、在 `execute` 里钳；
- 值班 agent 只给 5 只只读工具，`tools.restrict({ allow })` 的白名单在 `index.js` 的 `DUTY_ALLOW`；
- **不要加回任何写操作**（点赞/评论/关注/私信）——用户明确要求不做互动；
- 任何写盘/日志都要自己 try/catch —— 插件出错只该「这一轮没跑成」，不该杀宿主；
- 设置页接口只接受本机同源请求（`sameOriginOk`）；
- 登录只保留传统 cURL / Cookie 导入；**不要加回扫码、短信、密码登录**。

## 测试

```bash
NODE="/path/to/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$NODE" --expose-internals --test test/*.test.mjs
```

临时实例（不碰真实 `~/.dsh`）：

```bash
export DSH_HOME="$PWD/.dsh-test"
dsh --profile web --dump-config
dsh plugin --profile web add "$PWD/dsh-zhihu-scroll"
dsh web --port 0 --no-open
```
