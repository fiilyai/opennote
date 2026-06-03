# 微信 iLink 接入 · 协议调研 + Pi Agent 集成设计

> Day 5 大章的设计底稿。来源：逆向阅读 `@tencent-weixin/openclaw-weixin`（iLink channel 插件）源码 + Pi（`@earendil-works/pi-*`）的 extension/agent API。
> 落地路线：**先内联进 opennote 跑通（C 路线），通了再抽成独立的 `weixin-ilink` 包**。
> 本文只描述协议事实与集成设计，不含实现代码。

---

## 0. 目标与范围

把"用微信给 opennote 发消息、它在后台处理并回复"这条链路打通。

- **MVP**：扫码登录 + 长轮询常驻 + 单 agent 收发文本/链接。
- **不在 MVP**：图片/文件/语音媒体、多 agent 路由、多会话并发、群聊、抽独立包。
- **服务对象**：先是你自己一个微信号。

---

# 一、微信 iLink 协议调研

## 1.1 它是什么

微信官方的 **iLink 机器人（bot）API**。要点：

- **扫码登录的 bot**，不是公众号被动回复 webhook，也不是 itchat / wechaty 那种客户端协议逆向。
- **主动长轮询（long-poll）拉消息**，不开任何监听端口、不需要公网回调 URL。
- 一次扫码 = 一个 bot 身份（`botToken` + `ilink_bot_id`）。
- 全部走 HTTP + JSON（proto 的 bytes 字段在 JSON 里是 base64 字符串）。

**两个固定服务地址**（openclaw 里的默认值）：

| 用途 | URL |
|---|---|
| API base | `https://ilinkai.weixin.qq.com` |
| CDN base（媒体） | `https://novac2c.cdn.weixin.qq.com/c2c` |

## 1.2 端点总览

所有 API 端点都挂在 `{baseUrl}/` 下，除登录两个是 GET，其余是 POST JSON。

| 端点 | 方法 | 作用 | MVP |
|---|---|---|---|
| `ilink/bot/get_bot_qrcode?bot_type=3` | GET | 取登录二维码 | ✅ |
| `ilink/bot/get_qrcode_status?qrcode=<qr>` | GET（长轮询） | 轮询扫码状态、拿 token | ✅ |
| `ilink/bot/getupdates` | POST | 长轮询拉新消息 | ✅ |
| `ilink/bot/sendmessage` | POST | 下发一条消息 | ✅ |
| `ilink/bot/getconfig` | POST | 取 bot 配置（含 typing_ticket） | ⛔（可选） |
| `ilink/bot/sendtyping` | POST | 发"正在输入"状态 | ⛔（可选） |
| `ilink/bot/getuploadurl` | POST | 取 CDN 上传预签名 | ⛔（媒体） |

## 1.3 鉴权与请求头

每个**业务 POST**（getupdates / sendmessage / …）带这些头：

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <botToken>            # 登录拿到的 token
X-WECHAT-UIN: <base64(String(随机 uint32))>  # 每请求随机
Content-Length: <字节数>
SKRouteTag: <routeTag>                       # 可选，机房路由，配置里有才带
```

每个请求体还会附一个 `base_info: { channel_version }`（无关紧要的版本标记，移植时可塞个常量或省略）。

登录两个 GET 不带 `Authorization`；`get_qrcode_status` 额外带 `iLink-App-ClientVersion: 1`。

## 1.4 登录流程（扫码状态机）

```
[1] GET get_bot_qrcode?bot_type=3
      ← { qrcode, qrcode_img_content }
      # qrcode = 后续轮询用的 key；qrcode_img_content = 给用户扫的二维码链接/内容
      # 把 qrcode_img_content 用 qrcode-terminal 画成终端二维码，或打印链接让用户浏览器打开

[2] 循环：GET get_qrcode_status?qrcode=<qrcode>   (服务端长轮询 ~35s，超时算 wait)
      ← { status, bot_token?, ilink_bot_id?, baseurl?, ilink_user_id? }
      status ∈ {
        "wait"      → 还没扫，继续轮询（每轮间隔 ~1s）
        "scaned"    → 已扫码，提示用户在微信里确认
        "expired"   → 二维码过期 → 重新 get_bot_qrcode 刷新（最多 3 次）
        "confirmed" → 成功！取 bot_token + ilink_bot_id + ilink_user_id
      }
```

`confirmed` 时拿到的关键字段：

| 字段 | 含义 | 怎么用 |
|---|---|---|
| `bot_token` | bot 鉴权 token | 存起来，之后所有请求的 `Authorization: Bearer` |
| `ilink_bot_id` | bot 身份 id（形如 `xxx@im.bot`） | = accountId，存储/路由的主键 |
| `baseurl` | 服务端指定的 base（可能覆盖默认） | 有就用它覆盖 baseUrl |
| `ilink_user_id` | **扫码人**的微信 user id | **直接加进 allowFrom 白名单**（见 2.8） |

整段登录有 5 分钟 TTL；二维码过期会自动刷新（≤3 次）。

## 1.5 收消息（getUpdates 长轮询）

核心是一个**游标长轮询**：

```
POST ilink/bot/getupdates
body: { get_updates_buf: <上一轮返回的游标，首轮 ""> , base_info }
  ← {
      ret,                       # 0 = ok
      errcode, errmsg,           # 失败时；errcode -14 = 会话过期
      msgs: WeixinMessage[],     # 本轮新消息
      get_updates_buf,           # 新游标，存下来下轮带上
      longpolling_timeout_ms,    # 服务端建议的下轮超时
    }
```

要点：

- **`get_updates_buf` 是同步游标**：每轮把服务端返回的 buf 原样存下、下轮带上。它要**持久化到磁盘**，重启后接着拉，不丢消息。
- 客户端超时（默认 ~35s）是正常的 —— 当成"本轮无消息"，直接拿同一个 buf 重试。
- 服务端可能用 `longpolling_timeout_ms` 指定下轮超时。
- 每条 `WeixinMessage` 带一个 **`context_token`**：回消息时必须原样回显（见 1.6）。

## 1.6 发消息（sendMessage）

```
POST ilink/bot/sendmessage
body: {
  msg: {
    from_user_id: "",            # 留空
    to_user_id: <对方 user id>,  # = 入站消息的 from_user_id
    client_id: <随机幂等 id>,
    message_type: 2,             # BOT
    message_state: 2,            # FINISH
    item_list: [ { type: 1, text_item: { text: "<回复内容>" } } ],  # type 1 = TEXT
    context_token: <该用户最近一条入站消息的 context_token>,        # 必须回显
  },
  base_info
}
```

要点：

- **`context_token` 必须带**：它是"回到正确会话"的钥匙。按 `accountId:userId` 缓存最近一条入站消息的 token，发的时候取出来。缺了它服务端可能投递不到正确会话。
- 回复给谁：`to_user_id` = 入站消息的 `from_user_id`。
- 模型回复是 markdown，微信只认纯文本 → 发之前做一次 **markdown → 纯文本**（去代码围栏保留内容、链接只留显示文字、表格压平、去掉图片语法）。

## 1.7 消息结构

```
WeixinMessage {
  from_user_id, to_user_id, client_id,
  session_id, group_id,            # group_id 非空 = 群聊（MVP 只处理直聊）
  create_time_ms, ...
  message_type,                    # 1=USER 2=BOT
  item_list: MessageItem[],
  context_token,                   # 回显用
}

MessageItem {
  type,                            # 1=TEXT 2=IMAGE 3=VOICE 4=FILE 5=VIDEO
  text_item:  { text },
  voice_item: { ..., text },       # 语音可能自带转写文字
  image_item / file_item / video_item: { media: CDNMedia, ... },
  ref_msg,                         # 引用消息（"[引用: …]\n正文"）
}
```

**入站取文本**：遍历 `item_list`，取第一个 `TEXT` 的 `text_item.text`；语音若带 `voice_item.text` 直接用；引用消息拼成 `[引用: 标题|内容]\n正文`。MVP 只要处理 TEXT 就够（链接也是 TEXT）。

## 1.8 媒体（MVP 不做，先记着）

图片/文件/视频走 CDN + **AES-128-ECB** 加密：发要先 `getuploadurl` 上传密文再带 CDN 引用；收要按 `aeskey` 下载解密。语音是 SILK 编码，需转码成 WAV。这一坨整体后置，MVP 只收发文本。

## 1.9 typing（可选锦上添花）

`getconfig` 拿 `typing_ticket` → `sendtyping(status=1)` 发"正在输入"，处理完 `status=2` 取消。能缓解"长时间没反应"的焦虑，但非必需，放后面。

## 1.10 错误与重连

- `errcode === -14`（或 `ret === -14`）= **会话过期**：暂停一段时间（openclaw 是几分钟）再继续，别狂打。严重时需要重新登录。
- 连续失败计数 + 退避（openclaw：连续 N 次失败后 backoff 30s）。
- 客户端超时不算失败，直接重试。

## 1.11 存储与凭证

openclaw 存在 `~/.openclaw/openclaw-weixin/`，**opennote 改到 `~/.opennote/weixin/`**：

```
~/.opennote/weixin/
  accounts/<accountId>.json                  # { botToken, baseUrl, userId, ... }
  accounts/<accountId>.context-tokens.json   # { <userId>: <contextToken> }  回显用，重启恢复
  accounts/<accountId>.get-updates-buf       # 长轮询游标，持久化
```

token 等凭证**不进 opennote.yaml、不进 git**。

---

# 二、接入 Pi Agent 的设计

## 2.1 Pi 两层 & opennote 的选择

- `pi-agent-core` —— agent 内核（`new Agent()`），**opennote 直接用这层**。
- `pi-coding-agent` —— 完整 CLI 运行时（`SessionManager` + `ExtensionRunner` + TUI）。Pi 的"正经 extension 体系"（`discoverAndLoadExtensions`、`ExtensionAPI.sendUserMessage`、`InputSource: "extension"`）在这层。

opennote **没采用** pi-coding-agent 的运行时（自己拿 pi-agent-core 搭的极简 loop）。所以 Day 5 **不做 Pi extension，而是用 opennote 自己的 agent loop 写一个 `serve` 通道**。等抽包时，把适配器接口对齐 Pi 的 extension 契约（模仿 `sendUserMessage`），将来若升级到完整 runtime 能平滑变成真 extension。

## 2.2 适配架构

```
opennote serve（常驻进程，无监听端口）
  │
  ├─ 启动：读 ~/.opennote/weixin/accounts/<id>.json 拿 token + 恢复游标/contextToken
  │
  └─ monitor 长轮询循环（while !abort）
        getUpdates(buf)
          ├─ 处理 errcode（-14 会话过期 → 暂停）/ 退避
          ├─ 存新游标 get_updates_buf
          └─ for each msg:
               ├─ 解析 → { from, body, contextToken }
               ├─ 缓存 contextToken（accountId:from）
               ├─ allowFrom 白名单校验（不在白名单 → 丢弃/拒答）   ← 安全闸
               ├─ agent = resolveAgent(msg)        ← 路由 seam，MVP 永远返回那一个
               ├─ reply = await runAgentOnce(agent, body)   ← 驱动 agent、取回复
               └─ sendMessage(to=from, text=md→plain(reply), contextToken)
```

## 2.3 从 openclaw 移植什么 / 剥什么

| openclaw 源文件 | 处理 | 说明 |
|---|---|---|
| `api/api.ts` | **移植** | 端点封装，剥掉 openclaw 的 logger/redact，换 opennote 的；`routeTag` 简化 |
| `api/types.ts` | **直接搬** | 纯协议结构，零耦合 |
| `auth/login-qr.ts` | **移植** | 登录状态机，去掉 openclaw 的 accounts/routeTag 依赖 |
| `cdn/*`、`media/*` | 暂不搬 | MVP 不做媒体 |
| `messaging/send.ts` 的 `markdownToPlainText` | **搬** | 但 `stripMarkdown` 来自 openclaw，自己实现一版极简的 |
| `messaging/inbound.ts` 的取文本/contextToken 逻辑 | **移植** | 改成 opennote 的存储路径 |
| `channel.ts` / `runtime.ts` / `monitor.ts` / `process-message.ts` | **重写** | openclaw 胶水（ChannelPlugin/PluginRuntime/路由/回复派发）→ 换成 opennote 的 monitor + run-once + router |
| `storage/state-dir.ts` | **替换** | `~/.openclaw` → `~/.opennote/weixin` |

预估：协议核心 ~1200 行可移植，胶水 ~300-500 行要新写（但比 openclaw 那 1800 行简单，因为 opennote 的回复管道更直白）。

## 2.4 `runAgentOnce`：怎么驱动 agent 并取回复

opennote 的 `Agent` 是事件流式的（见 `src/commands/chat.ts` 的 `agent.subscribe`）。封装一个：

```
runAgentOnce(agent, text): Promise<string>
  - 订阅 agent 事件
  - 累积 assistant 的 text_delta（每个 message_start 重置当前段）
  - agent.prompt(text)
  - 在 turn 结束（turn_end / agent_end）时，resolve 最终 assistant 文本
  - 取消订阅
```

这等价于 Pi extension 的 `sendUserMessage` + 观察输出。**MVP 串行**：一条消息 await 处理完再拉下一条，天然避开并发。

## 2.5 路由 seam（resolveAgent）

```
resolveAgent(msg): Agent
  // MVP：永远返回那唯一一个 agent
  // 未来：按 from（联系人）/ 命令前缀（/note /ask）查注册表 → 不同 agent（各自 notesDir/persona/model）
```

一个微信号 = 一条连接；"绑多个 agent"就是往这个注册表里加配置。MVP 先注册一个，seam 留好。

## 2.6 会话模型

- **MVP**：单 agent = 所有消息进**同一个对话上下文**，**串行**处理。服务你自己够用。
- **未来**：一人一会话（每个 `from` 一个独立上下文 / `notesDir`），回复按 `context_token` + `to_user_id` 路由回正确的人。Pi 这层我们自己管，不依赖 SessionManager。

## 2.7 配置

`opennote.yaml`（token 不在这里，在凭证文件）：

```yaml
weixin:
  enabled: true
  baseUrl: https://ilinkai.weixin.qq.com   # 可选，默认即此
  allowFrom:                               # 白名单：只有这些 ilink_user_id 能驱动 agent
    - <你的 ilink_user_id>                  # 登录成功时回显的 userId，直接填这
```

config schema 已有 `weixin.enabled` 占位，Day 5 补 `baseUrl` / `allowFrom`。

## 2.8 安全（必须，重点）

**这是把外部输入直接接到一个带 `bash` / `write` / `edit` 工具的 agent 上。** 等于把 shell 暴露给"任何能给这个 bot 发消息的人"。所以：

- **`allowFrom` 白名单是硬闸**：不在白名单的 `from_user_id` 一律丢弃（或回一句"无权限"）。**默认空 = 谁都不行**，逼用户显式配置。
- 登录成功回显的 `ilink_user_id` 就是你自己，引导用户把它加进 `allowFrom`。
- （后续可加）命令级鉴权、危险工具在微信通道下降权等。MVP 至少白名单到位。

## 2.9 CLI 命令

cli.ts 里早留了 TODO，Day 5 落地：

| 命令 | 作用 |
|---|---|
| `opennote login` | `get_bot_qrcode` → 终端画二维码 → 轮询 `get_qrcode_status` → `confirmed` 后存 token 到 `~/.opennote/weixin/accounts/`，并提示把回显的 userId 加进 allowFrom |
| `opennote serve` | 读凭证 → 起 monitor 长轮询循环，常驻前台，Ctrl-C 干净退出（abort）|

## 2.10 进程模型

`serve` 是一个**前台常驻**进程：一个 `while(!abort)` 长轮询循环，**不开任何端口、无 webhook**。和 `chat`（交互 REPL）是两个独立入口，共用同一套 agent 装配（`createOpennoteAgent`）。

---

# 三、MVP 实现清单（文件级）

```
src/weixin/
  ilink.ts        # 端点封装（移植 api.ts）：getUpdates / sendMessage [+ getConfig/sendTyping 可选]
  login.ts        # 扫码登录状态机（移植 login-qr.ts）+ qrcode-terminal 渲染
  types.ts        # 协议结构（搬 api/types.ts）
  accounts.ts     # 凭证/游标/contextToken 存取（~/.opennote/weixin/）
  inbound.ts      # WeixinMessage → { from, body, contextToken }（取文本逻辑）
  send.ts         # markdown→纯文本 + 组 sendMessage 请求
  monitor.ts      # 长轮询主循环 + 错误/退避 + 派发
  router.ts       # resolveAgent(msg) seam（MVP 返回单 agent）
  run-once.ts     # runAgentOnce(agent, text) → reply（订阅事件取回复）

src/commands/
  login.ts        # opennote login
  serve.ts        # opennote serve

src/cli.ts        # 注册 login / serve 子命令
src/config.ts     # weixin.baseUrl / weixin.allowFrom
```

**跑通验证（需你本人扫码）**：
1. `opennote login` → 扫码 → 看到 `confirmed` + 存下 token。
2. 把回显 userId 填进 `opennote.yaml` 的 `allowFrom`。
3. `opennote serve` → 用微信给 bot 发一条文本/链接 → agent 处理 → 收到回复。
4. 发个公众号链接 → 触发 wiki-ingest → 回一句"收好了，建了哪几页"。

---

# 四、开放问题 / 后续

- **抽独立包**：跑通后把 `ilink.ts/login.ts/types.ts/accounts.ts`（纯协议）抽成 `@fiilyai/weixin-ilink`，opennote 只留 monitor/router/run-once 适配器。
- **多 agent 路由**：resolveAgent 按联系人 / 命令前缀分流。
- **多会话并发**：一人一上下文 + 并发处理（要处理 agent 实例/会话隔离）。
- **媒体**：图片/语音/文件（CDN + AES + SILK→WAV）。
- **typing 指示 + 进度反馈**：和"进度 UI 专题"合流。
- **会话过期自愈**：errcode -14 后自动提示重新 `login`。
