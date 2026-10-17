# ragents-chat：基于 ragents 的多 Agent 群聊与协作系统设计文档

- **项目目录**：`ragents-chat/`
- **设计原则**：对现有 `ragents/` **100% 零代码侵入**；完全通过 `ragents-client` SDK、`ragents-protocol` 标准协议与 WASI 0.2 插件机制构建。
- **核心组成**：
  1. **聊天室插件 (`extensions/chatroom` $\rightarrow$ `ragent_chatroom_extension.wasm`)**
  2. **聊天室服务端 (`crates/chatroom-server`)**
  3. **Web 客户端 (`web/`，可内嵌于 `chatroom-server` 单二进制分发)**

---

## 1. 总体架构与零侵入集成方案

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              Web 客户端 (Browser SPA)                                   │
│  ┌──────────────────────────────┐  ┌─────────────────────────────────────────────────┐ │
│  │ 聊天室主视图 (Room Timeline)   │  │ Agent 内部 Session 实时透视面板 (严格只读对话)    │ │
│  │ - 单聊默认显式自动 @ 唯一 Agent│  │ - 实时查看思考流 / Shell / 文件读写 / 压缩血缘   │ │
│  │ - 群聊自由 @Agent / @Manager │  │ - 交互式 5 级权限审批 (含自定义路径) & 紧急 Cancel │ │
│  └──────────────┬───────────────┘  └────────────────────────┬────────────────────────┘ │
└─────────────────┼───────────────────────────────────────────┼──────────────────────────┘
                  │ HTTP REST + SSE / WebSocket               │
                  ▼                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        聊天室服务 (ragents-chat / chatroom-server)                      │
│                                                                                        │
│  ┌─────────────────────┐  ┌──────────────────────────┐  ┌───────────────────────────┐  │
│  │ Room & Message Store│  │ RoomCoordinator (调度器)  │  │ Manager Service (管家服务)│  │
│  │ (chatroom.sqlite3)  │  │ - 维护每个 Agent 已读游标 │  │ - 响应 @Manager 招募请求  │  │
│  │ - rooms             │  │ - @ 唤醒 (Idle / Busy)   │  │ - 通过 ragents-apiserver  │  │
│  │ - room_agents       │  │ - 空闲主动窥屏 (Idle Peek)│  │   调用 LLM 生成新 Agent   │  │
│  │ - room_messages     │  │ - 自动追踪 Session 压缩链│  │   配置并创建绑定 Session  │  │
│  └─────────────────────┘  └─────────────┬────────────┘  └─────────────┬─────────────┘  │
└───────────────────▲─────────────────────┼─────────────────────────────┼────────────────┘
                    │                     │                             │
   WASI 0.2 HTTP    │                     │ ragents-client SDK          │ ragents-client SDK
   Callback         │                     │ (REST + SSE /api/v1/watch)  │ (REST + SSE)
   (/api/v1/internal│                     ▼                             ▼
    /agent-speak)   │       ┌──────────────────────────────────────────────────────────┐
                    │       │               ragents-apiserver (零改动)                  │
                    │       │  - Sessions / Activations / Realtime Queue / Compactions │
                    │       └─────────────────────────────┬────────────────────────────┘
                    │                                     │ WebSocket Tunnel
                    │                                     ▼
                    │       ┌──────────────────────────────────────────────────────────┐
                    │       │               ragents-daemon & ragents-core (零改动)      │
                    │       │  ┌────────────────────────────────────────────────────┐  │
                    └───────┼──┤ chatroom.wasm (WASI 0.2 插件)                      │  │
                            │  │ - agent.prepare: 注入群聊身份、群友列表与发言规则   │  │
                            │  │ - tools.call: 提供 `chatroom_speak` 唯一公开发言工具│  │
                            │  └────────────────────────────────────────────────────┘  │
                            └──────────────────────────────────────────────────────────┘
```

### 1.1 为什么能做到对 `ragents/` 零代码侵入？
1. **WASI 0.2 原生网络直通**：
   `ragents-core` 已原生实现 WASI 0.2 `wasi:http/outgoing-handler`。因此 `chatroom.wasm` 可以直接在 WASM 内部向 `chatroom-server` 发起 HTTP 请求（调用公开发言接口），无需修改 `ragents/wit/ragent-extension.wit` 或 `ragents-core` 宿主代码。
2. **统一通过 `push_realtime_message` 投递（无需在聊天室侧区分 Idle / Busy）**：
   因为 `ragents-apiserver` 的 `push_realtime_message` 已经在单个 SQLite 事务内实现了**“忙碌时注入当前运行循环、空闲时自动创建并调度 `Continuation` Activation 唤醒”**的原子语义：
   - `chatroom-server` 向任何群内 Agent 投递消息（无论是 `@` 唤醒还是窥屏投递）时，**完全不需要自己判断该 Agent 当前是不是 `Idle`，统一直接调用 `client.push_realtime_message` 即可**！
   - 这不仅大幅简化了 `chatroom-server` 的投递代码，还彻底消除了“`chatroom-server` 以为 Agent 还在忙，结果请求到达前 1ms Agent 刚跑完导致状态判断竞态”的分布式并发问题。
3. **三会话压缩血缘事件已完备**：
   `ragents-apiserver` 在触发上下文压缩时会广播 `SessionEvent::SessionCompacted { from_session_id, compaction_session_id, continued_session_id, continued_activation_id, .. }`，且 `push_realtime_message` 对旧 Session 的请求也会自动顺着 `continued_in_session_id` 路由并返回最新的 `target_session_id`。

---

## 2. 核心领域模型与数据库设计 (`chatroom.sqlite3`)

### 2.1 单聊与群聊完全统一的 `Room` 模型
系统底层**只有 `Room`（聊天室）一种容器**：
- 创建任意 `Room` 时，默认包含：
  1. **1 个内置默认 Agent**（根据全局默认模板创建，并立即在 `ragents-apiserver` 中创建其专属 `Session`）；
  2. **聊天室管家 (`@Manager`)**（系统级能力入口，不属于群聊普通 Agent，不参与窥屏与互 `@` 循环）。
- **单聊态 (`agent_count == 1`)**：前端输入框默认显式挂载 `@<默认Agent名称>` 标签，用户体验与传统 1v1 AI 对话一致，但底层走的完全是群聊 `@` 投递链路。
- **群聊态 (`agent_count >= 2`)**：当人类通过 `@Manager` 或手动招募第 2 个 Agent 进入房间后，该房间自然成为多 Agent 群聊。

### 2.2 SQLite 表结构设计 (`chatroom.sqlite3`)

```sql
-- 1. 全局 Manager 与默认模板配置表 (单行配置 id = 1)
CREATE TABLE IF NOT EXISTS manager_settings (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    manager_model           TEXT NOT NULL,          -- Manager 自身使用的模型 (如 gemini-3.8-flash)
    manager_system_prompt   TEXT NOT NULL,          -- Manager 招募/设计新 Agent 的系统提示词
    default_node_id         TEXT,                   -- 新 Agent 默认绑定的节点 (为空则为 Floating)
    default_workspace_root  TEXT,                   -- Pinned 模式下默认工作区根目录
    default_agent_model     TEXT NOT NULL,          -- 新建 Agent 的默认模型
    default_extensions_json TEXT NOT NULL,          -- 默认挂载的扩展列表 (shell, file_editor, skills, compaction 等)
    idle_peek_debounce_ms   INTEGER NOT NULL DEFAULT 800,
    max_agent_relay_depth   INTEGER NOT NULL DEFAULT 12, -- 连续无人类发言时的最大 Agent 接力轮数保护
    updated_at              TEXT NOT NULL
);

-- 2. 聊天室表 (含房间级实时可调的窥屏与轮流插嘴控制参数)
CREATE TABLE IF NOT EXISTS rooms (
    room_id                 TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    last_msg_seq            INTEGER NOT NULL DEFAULT 0, -- 房间内单调递增的消息序号 (1, 2, 3...)
    roster_version          INTEGER NOT NULL DEFAULT 1, -- 群成员名册版本号 (仅当增删 Agent 时 +1)
    peek_enabled            INTEGER NOT NULL DEFAULT 1, -- 窥屏总开关 (0=关闭, 1=开启)
    peek_idle_secs          INTEGER NOT NULL DEFAULT 3, -- 窥屏触发时间间隔 (秒)
    peek_msg_interval       INTEGER NOT NULL DEFAULT 1, -- 窥屏触发对话轮次间隔 (每累计 N 条新消息)
    interject_enabled       INTEGER NOT NULL DEFAULT 1, -- 插嘴总开关 (0=纯窥屏禁言, 1=允许按概率插嘴)
    mute_probability        INTEGER NOT NULL DEFAULT 40,-- 禁言概率 (0~100，随机数低于该值则本轮直接禁言)
    max_agent_relay_depth   INTEGER NOT NULL DEFAULT 12,-- 连续无人类发言时的最大 Agent 接力轮数保护
    consecutive_agent_msgs  INTEGER NOT NULL DEFAULT 0, -- 连续由 Agent 发送的消息计数 (人类发言归零)
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

-- 3. 群内 Agent 成员表 (严格 1 Agent <-> 1 Session 演进链)
CREATE TABLE IF NOT EXISTS room_agents (
    agent_id                TEXT PRIMARY KEY,
    room_id                 TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    name                    TEXT NOT NULL,          -- 群内唯一昵称，用于 @name 匹配 (如 "Coder", "Reviewer")
    role_title              TEXT NOT NULL,          -- 角色头衔 (如 "Rust 后端工程师")
    avatar                  TEXT NOT NULL,          -- 头像标识 / Emoji
    persona_prompt          TEXT NOT NULL,          -- Agent 专属人设提示词
    model                   TEXT NOT NULL,
    scheduling_json         TEXT NOT NULL,          -- SchedulingMode (Pinned / Floating)
    root_session_id         TEXT NOT NULL,          -- 初始创建的 ragents SessionId
    active_session_id       TEXT NOT NULL,          -- 当前活跃的 ragents SessionId (随自动压缩平滑演进)
    session_chain_json      TEXT NOT NULL,          -- 完整压缩血缘链记录: [{gen, working_session_id, compaction_session_id}]
    last_delivered_seq      INTEGER NOT NULL DEFAULT 0, -- 已投递给该 Agent 的最高房间消息序号 msg_seq
    last_roster_version     INTEGER NOT NULL DEFAULT 0, -- 已同步给该 Agent 的群成员名册版本号 (仅变动时增量同步)
    allow_speak_in_turn     INTEGER NOT NULL DEFAULT 1, -- 当前轮次是否允许调用 chatroom_speak (禁言窥屏时为 0)
    runtime_state           TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'thinking' | 'waiting_permission'
    active_activation_id    TEXT,                   -- 当前正在运行的 ActivationId
    agent_secret_token      TEXT NOT NULL,          -- 供 chatroom.wasm 回调鉴权使用的一次性/专属 Token
    created_by              TEXT NOT NULL,          -- 'system' | 'human' | 'manager'
    created_at              TEXT NOT NULL,
    UNIQUE (room_id, name)
);
CREATE INDEX IF NOT EXISTS idx_room_agents_room ON room_agents(room_id);
CREATE INDEX IF NOT EXISTS idx_room_agents_active_session ON room_agents(active_session_id);

-- 4. 聊天室公开消息表
CREATE TABLE IF NOT EXISTS room_messages (
    room_id                 TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    msg_seq                 INTEGER NOT NULL,       -- 房间内从 1 开始严格递增的序号
    message_id              TEXT NOT NULL UNIQUE,
    sender_kind             TEXT NOT NULL,          -- 'human' | 'agent' | 'manager' | 'system'
    sender_id               TEXT NOT NULL,          -- 'human' / agent_id / 'manager' / 'system'
    sender_name             TEXT NOT NULL,
    content                 TEXT NOT NULL,          -- 消息正文
    mentions_json           TEXT NOT NULL DEFAULT '[]', -- 解析出的显式 @ 列表 (如 ["Coder", "Manager"])
    reply_to_seq            INTEGER,                -- 可选引用的历史消息 msg_seq
    source_session_id       TEXT,                   -- 若由 Agent 发送，记录当时所在的 ragents SessionId
    source_activation_id    TEXT,                   -- 若由 Agent 发送，记录当时所在的 ActivationId
    created_at              TEXT NOT NULL,
    PRIMARY KEY (room_id, msg_seq)
);
```

---

## 3. 聊天室插件 (`chatroom.wasm`) 设计

### 3.1 插件职责与配置注入
每个群聊 Agent 的 `SessionSpec.extensions` 中都会自动挂载 `ragent_chatroom_extension.wasm`，并由 `chatroom-server` 在创建或更新 Session 时传入如下 `config`：

```json
{
  "chatroom_callback_url": "http://127.0.0.1:8090/api/v1/internal/agent-speak",
  "room_id": "room_01a1...",
  "room_name": "核心架构重构群",
  "agent_id": "agt_01a1...",
  "agent_name": "Coder",
  "agent_role": "Rust 核心开发工程师",
  "agent_token": "tok_secret_...",
  "peers": [
    { "name": "Human", "role": "人类用户" },
    { "name": "Manager", "role": "聊天室管家（可 @Manager 招募新专家 Agent）" },
    { "name": "Reviewer", "role": "代码审查与测试专家" }
  ]
}
```
*(注：同时在 `SessionSpec.permissions.http_hosts.allow` 中自动放行 `chatroom-server` 所在地址，使得 `chatroom.wasm` 调用回调接口时免弹窗直接放行。)*

### 3.2 Hook 1：`agent.prepare`（群聊认知与行为准则注入）
`chatroom.wasm` 在 `agent.prepare` 阶段自动向 Agent 的 `system_prompt` 追加 `<chatroom_protocol>` 指令块，并注册唯一公开发言工具 **`chatroom_speak`**：

1. **注入的群聊行为准则（核心要点）**：
   - **私密内循环 vs 公开发言分离**：你在当前 Session 中的所有推理思考、文件读写（`read_file`/`write_file`）、命令执行（`shell`）以及直接输出的普通文本，**全部是你个人的私密草稿/工作笔记，群聊中的人类和其他 Agent 完全看不见**。
   - **唯一公开发言通道**：只有当你调用 `chatroom_speak` 工具时，你的话才会真正发送到聊天室。
   - **被 `@` 唤醒时的职责**：如果输入中包含 `[Chatroom Direct Mention (@You)]`，说明人类或群友正在点名与你对话或向你委派任务。请先在私密循环内完成必要的调查、编码或验证，然后**必须调用 `chatroom_speak`** 在群里给出明确回复或汇报结果。
   - **空闲窥屏（`[Chatroom Unread Peek]`）时的决策（插嘴 vs 静默围观）**：
     - 如果输入是 `[Chatroom Unread Peek]`（没有直接 `@` 你），说明你正处于空闲状态浏览群内未读消息；
     - **何时插嘴**：只有当未读消息涉及你的专业领域、发现了明显错误/风险、或你能提供关键补充信息时，才调用 `chatroom_speak` 发言；
     - **何时静默围观**：如果其他人的讨论与你无关或无需你补充，**请不要调用 `chatroom_speak`**，直接结束本轮回复（例如只输出一句简短的内部笔记 `Observed.`），即可做到群内零打扰且将讨论内容记入你自己的上下文。
   - **如何与其他人协作**：
     - 需要其他 Agent 协助或追问细节时，在 `chatroom_speak` 的 `mentions` 参数中填入对方名字（如 `["Reviewer"]`）；
     - 需要招募群里目前没有的新角色时，在 `chatroom_speak` 的 `mentions` 中填入 `["Manager"]` 并说明所需角色的能力、工具和工作目录。

2. **暴露的工具定义 (`chatroom_speak`)**：
   ```json
   {
     "name": "chatroom_speak",
     "description": "Send a public message to the chatroom. Your normal text output is private to your internal session; you MUST call this tool whenever you want humans or other agents in the chatroom to see your message.",
     "parameters": {
       "type": "object",
       "properties": {
         "content": {
           "type": "string",
           "description": "The message content to post in the chatroom (Markdown supported)."
         },
         "mentions": {
           "type": "array",
           "items": { "type": "string" },
           "description": "Optional list of participant names to @mention (e.g. ['Human', 'Reviewer', 'Manager'])."
         },
         "reply_to_seq": {
           "type": "integer",
           "description": "Optional message sequence number (#seq) you are replying to."
         }
       },
       "required": ["content"]
     }
   }
   ```

### 3.3 Hook 2：`model.request.prepare` & `tools.call`（禁言动态剥夺工具 + WASI 0.2 HTTP 回传）
1. **被禁言时的工具级硬隔离 (`model.request.prepare`)**：
   - 当某次唤醒属于“被禁言的只读窥屏”（输入中包含 `[Chatroom Speak Permission: MUTED]`）时，`chatroom.wasm` 在 `model.request.prepare` Hook 中**直接从发往大模型的 `CreateResponseBody.tools` 列表中移除 `chatroom_speak` 工具**；
   - 同时若模型仍尝试调用 `chatroom_speak`，`chatroom-server` 校验 `allow_speak_in_turn == 0` 也会直接返回无权限错误，实现双重硬隔离。
2. **公开发言回调 (`tools.call`)**：
   - 当获准发言的 Agent 调用 `chatroom_speak` 时，`chatroom.wasm` 通过 WASI 0.2 `wasi:http/outgoing-handler` 向 `chatroom-server` 发送 `POST /api/v1/internal/agent-speak`；
   - 请求头携带 `Authorization: Bearer <agent_token>`；
   - 请求体包含 `{ room_id, agent_id, content, mentions, reply_to_seq }`；
   - `chatroom-server` 校验通过后写入 `room_messages`，分配新的 `msg_seq`，向前端实时推送该群消息，并返回 `{ "ok": true, "msg_seq": 42 }` 给 `chatroom.wasm`。

---

## 4. 群聊交互、窥屏掷骰与轮流插嘴状态机 (`RoomCoordinator`)

### 4.1 增量群名册同步与唤醒消息组装格式

- **群成员名册仅在变动时增量同步（保护 Prefix KV Cache）**：
  - `chatroom.wasm` 在 `agent.prepare` 注入的 `system_prompt` 保持静态不变，绝不随群成员增减而修改，从而 **100% 保护大模型 Prefix KV Cache**；
  - 房间维护 `roster_version`（仅在招募新 Agent 或移除 Agent 时 `+1`），每个 Agent 记录 `last_roster_version`；
  - 仅当 `agent.last_roster_version < room.roster_version` 时，才会在下一次唤醒该 Agent 的消息头部附带一次性的 `[Room Roster Updated (vN): ...]` 名册更新块，并将 `last_roster_version` 更新为 `N`；日常消息往来不再重复附带名册。

#### 格式 A：被显式 `@` 唤醒（`Direct Mention`）
当最新消息（或未读批次中的某条消息）显式 `@` 了 `Agent X` 时：

```text
=== [Chatroom Unread Context | Room: 核心架构重构群] ===
[#10 | 14:20:01 | Human]: 我们准备给 API 加上速率限制模块。
[#11 | 14:20:15 | Architect (系统架构师) -> @Human]: 我建议采用令牌桶算法，配置文件放在 config/ratelimit.toml。

=== [Chatroom Direct Mention (@Coder) | Action Required] ===
[#12 | 14:20:30 | Human -> @Coder]: @Coder 请根据刚才 @Architect 的建议实现速率限制模块，写完后在群里告诉大家。

(Hint: Perform any necessary file/shell actions privately in your session, then call `chatroom_speak` to reply in the chatroom.)
```
- **被 `@` 漏调发言工具的自动提醒（Auto-Nudge）**：
  若某次 Activation 是由 **显式 `@`（Direct Mention）** 触发的，但当 `ActivationCompleted` 结束时该 Agent **一次都未调用 `chatroom_speak`**，系统自动向其追加最多 1 次轻量级提醒，确保被点名的 Agent 必定在群内给出交代。

#### 格式 B：空闲主动窥屏（`Idle Peek`：支持可插嘴态与禁言只读态）

```text
=== [Chatroom Unread Peek | Room: 核心架构重构群] ===
[Chatroom Speak Permission: ALLOWED] (或当被禁言时为 [Chatroom Speak Permission: MUTED])
[#13 | 14:22:10 | Coder (Rust 核心开发工程师) -> @Human]: @Human 我已经把速率限制器写好了，代码在 src/ratelimit.rs。

(System Note: You were NOT @mentioned. You are peeking at unread chatroom messages while idle.
 - If you have valuable input, corrections, or follow-up points, call `chatroom_speak` to chime in.
 - If no response is needed, do NOT call `chatroom_speak` and finish your turn to observe silently.)
```

### 4.2 房间级实时可调参数与“掷骰排序 · 轮流插嘴 · 发言即重排”算法

每个房间支持在 Web 界面实时调整以下 5 个窥屏与讨论控制参数：
1. **`peek_enabled`（窥屏开关）**：无讨论需求时可一键关闭窥屏；关闭后未被 `@` 的 Agent 不主动唤醒，未读消息留到下次被 `@` 时一并投递。
2. **`peek_idle_secs` & `peek_msg_interval`（窥屏触发频率）**：
   - 时间阈值 `peek_idle_secs`：房间内所有被 `@` 的 Agent 均已执行完毕且静默达到 $T$ 秒；
   - 轮次阈值 `peek_msg_interval`：房间内新产生达到 $K$ 条未读消息。
3. **`interject_enabled`（插嘴总开关）**：无讨论需求时可单独关闭插嘴能力（此时窥屏仅做纯静默阅读，移除 `chatroom_speak` 工具）。
4. **`mute_probability`（禁言概率，`0..=100`）**：决定每次窥屏时各 Agent 被禁言的概率。

#### 轮流插嘴核心状态机流程（Sequential Roll & Interrupt-on-Speak）

当房间达到窥屏触发条件（且无正在忙碌的被 `@` Agent）时，`RoomCoordinator` 启动**轮流窥屏与插嘴流程**：

```text
     ┌─────────────────────────────────────────────────────────────────────────┐
     │ 触发新一轮窥屏与插嘴流程 (找出所有有未读消息 `last_delivered_seq < M` 的 Agent) │
     └────────────────────────────────────┬────────────────────────────────────┘
                                          ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │ 1. 聊天室服务为每个待窥屏 Agent 生成随机数 `roll ∈ [0, 100]`                 │
     │    - 若 `!interject_enabled` 或 `roll < mute_probability`：              │
     │      判定为【本轮禁言】，不参与本轮插嘴序列（无插嘴工具权限）               │
     │    - 若 `interject_enabled` 且 `roll >= mute_probability`：              │
     │      加入【本轮允许插嘴候选队列】，并按随机数 `roll` 从高到低降序排列        │
     └────────────────────────────────────┬────────────────────────────────────┘
                                          ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │ 2. 按 `roll` 从高到低，依次向候选队列中的 Agent 发送窥屏消息 (串行逐个唤醒)   │
     └────────────────────────────────────┬────────────────────────────────────┘
                                          ▼
                        当前唤醒的 `Agent_i` 是否调用了 `chatroom_speak` 插嘴？
                       ┌──────────────────┴──────────────────┐
                       │ 否 (未调工具，选择静默围观)            │ 是 (成功发出了插嘴消息 `#M+1`！)
                       ▼                                     ▼
          推进 `Agent_i.last_delivered_seq = M`     【立即终止本轮候选队列后续发送！】
          继续唤醒本轮队列中的下一个 `Agent_{i+1}`   因为 `#M+1` 改变了群聊上下文：
                       │                            将 `#M+1` 并入最新上下文后，
                       ▼                            立即回到第 1 步【重新发起新一轮掷骰与插嘴流程】
          若队列所有候选 Agent 均未插嘴：             (直到某一轮没有任何 Agent 插嘴，或达到接力上限)
          【本轮多 Agent 讨论自然收敛结束！】
```

这一设计的三大优势：
1. **彻底消除“同时抢话”**：同一时刻最多只有 1 个最高优先级的窥屏 Agent 在决定是否插嘴；
2. **上下文始终最新**：一旦排在前面的 Agent 插了嘴，后面的 Agent 不会再基于过时的上文重复发言，而是在包含了刚才那句插嘴的**最新上下文**基础上重新掷骰评估；
3. **自然衰减收敛**：随着 `mute_probability` 的过滤与 Agent 自身的静默判断，讨论会在几轮高质量补充后自然停下。

### 4.4 防无限刷屏保护（Loop Guard）
- 房间维护 `consecutive_agent_msgs` 计数器：
  - 每当**人类 (`sender_kind == 'human'`)** 发送消息时，`consecutive_agent_msgs` 重置为 `0`；
  - 每当 **Agent** 调用 `chatroom_speak` 发送消息时，`consecutive_agent_msgs += 1`。
- 当 `consecutive_agent_msgs >= max_agent_relay_depth`（默认 `12`）时：
  - 暂停自动触发 Agent 之间的互 `@` 与 `Idle Peek`，并在聊天室插入一条系统提示：`[System] 群内 Agent 已连续讨论 12 轮，已暂停自动接力，等待人类进一步指示或点击“继续讨论”。`

---

## 5. 聊天室管家 (`@Manager`) 与动态招募机制

1. **Manager 的定位**：
   - Manager 是每个聊天室内置的“HR + 架构编排官”，但它**不在 `room_agents` 表中**，因此不参与日常未读消息窥屏。
   - 触发方式：
     - **方式一（自然语言 `@Manager`）**：人类或任意群内 Agent 在群聊消息中 `@Manager`（例如：`"@Manager 请帮我拉一个负责前端 React 组件编写的 Agent 和一个负责写 E2E 测试的 Agent，工作目录都绑定在 /tmp/demo-app"`）；
     - **方式二（Web 界面操作）**：用户在界面点击“招募新 Agent”，可手动填写表单，也可输入一句描述让 Manager 自动生成配置。
2. **Manager 调用 `ragents-apiserver` 生成新 Agent 的流程**：
   - `chatroom-server` 通过 `RagentsClient` 在 `ragents-apiserver` 上创建一个临时的 Manager Session（使用 `manager_settings.manager_model`，不挂载复杂工具，仅执行单轮 JSON Schema 结构化生成）；
   - 将当前房间的现有成员列表、节点支持的模型列表（通过 `client.list_nodes()` 获取）、默认工作目录和招募需求发给 Manager Session；
   - 解析出 Manager 生成的一个或多个 `NewAgentSpec`（包含 `name`、`role_title`、`avatar`、`persona_prompt`、`model`、`scheduling`、`extensions`）；
   - 对每个新 Agent：
     1. 调用 `client.create_session(...)` 在 `ragents-apiserver` 中创建其持久化的 `Session`（挂载 `chatroom.wasm`、`compaction.wasm` 及所需工具扩展）；
     2. 将新 Agent 写入 `room_agents` 表（初始 `last_delivered_seq` 设为触发招募前的消息序号，使其一进群就能看到招募它的上下文）；
     3. `@Manager` 在群内发出欢迎与介绍消息（若原请求中同时布置了任务，`@Manager` 会在消息中直接 `@新Agent` 触发其首轮工作！）。
3. **已有 Agent 的成员列表同步**：
   - 当群内新增或移除 Agent 时，`chatroom-server` 自动调用 `client.patch_session` 更新群内其余 Agent 的 `chatroom.wasm` 扩展 `config.peers`，让所有群友在下一轮都知道新成员的名字和职责。

---

## 6. Agent 与 Session 绑定及自动压缩无缝追踪

1. **严格单 Session 生命周期**：
   - 每个 `RoomAgent` 创建时生成唯一的 `root_session_id`，并设置 `active_session_id = root_session_id`。
   - 只要该 Agent 还在群内，无论是被 `@` 唤醒还是空闲窥屏，始终向 `active_session_id` 发送 `Activation` 或 `Realtime` 消息，从而保证 Agent 拥有完整、连续的个人记忆（包括它之前看过的群聊记录和私密执行过的工具历史）。
2. **上下文压缩接力自动追踪 (`SessionEvent::SessionCompacted`)**：
   - 每个群内 Agent 默认挂载 `ragent_compaction_extension.wasm`。
   - `chatroom-server` 后台常驻协程通过 `client.watch_events(None, last_rv)` 监听 `ragents-apiserver` 的全局事件流：
     - 当收到 `SessionEvent::SessionCompacted { from_session_id, compaction_session_id, continued_session_id, continued_activation_id, compaction_generation, tokens_before, .. }` 时：
     - 查找 `active_session_id == from_session_id` 的 `RoomAgent`；
     - 原子更新该 Agent 的 `active_session_id = continued_session_id`、`active_activation_id = Some(continued_activation_id)`，并将 `{ generation: compaction_generation, from_session_id, compaction_session_id, continued_session_id, tokens_before }` 追加到 `session_chain_json` 中；
     - 向 Web 前端推送 `AgentSessionCompacted` 状态更新事件，前端透视面板自动平滑切换到新 Session，同时保留历史压缩链供随时回溯查阅。

---

## 7. Web 客户端与 API 接口设计

### 7.1 Web 界面三栏布局设计

```text
┌───────────────────┬─────────────────────────────────────────┬────────────────────────────────────────┐
│ 左侧栏：房间与设置  │ 中间主栏：聊天室时间线 (Room Timeline)    │ 右侧栏：群成员 & Session 实时透视面板    │
├───────────────────┼─────────────────────────────────────────┼────────────────────────────────────────┤
│ [+ 新建聊天室]     │ # 核心架构重构群          [招募 Agent]   │ 👥 群内成员 (点击透视内部 Session)      │
│                   ├─────────────────────────────────────────┤ - 🛠️ Coder [🔵 思考中] [查看透视]       │
│ 💬 聊天室列表      │ [Human 14:20]                           │ - 🛡️ Reviewer [🟠 待审批(1)] [查看透视] │
│ - 🟢 默认助手 (1v1)│ @Coder 请实现 ratelimit 模块            │ - 🤖 @Manager (群管家)                 │
│ - 🔥 核心架构重构群│                                         ├────────────────────────────────────────┤
│   (2 Agents)      │ [Coder 14:21] (Rust 核心开发工程师)      │ 🔍 内部透视: Reviewer (严格只读对话)    │
│                   │ @Human @Reviewer 我已经实现完速率限制    │ [血缘: Gen0 -> Compact1 -> Gen1(当前)] │
│                   │ 模块，代码在 `src/ratelimit.rs`。        │ -------------------------------------- │
│                   │                                         │ 💭 [Thinking] 正在检查并发锁安全性...   │
│                   │ [Reviewer 正在思考 / 等待权限审批...]    │ 🔧 [Tool] shell: cargo test            │
│                   ├─────────────────────────────────────────┤ ⚠️ [权限申请 permreq_01a1...]          │
│ ⚙️ Manager 全局设置│ [@Coder ×] 输入消息，输入 @ 选择成员...  │   路径: /Users/alice/.cargo/registry   │
│ (配置模型/默认扩展)│                                  [发送] │   [调整路径] [批准:本会话▼] [拒绝]     │
│                   │                                         │                        [⛔ 紧急中止执行]│
└───────────────────┴─────────────────────────────────────────┴────────────────────────────────────────┘
```

### 7.2 核心交互细节
1. **单聊自动显式 `@` 与群聊 `@` 补全**：
   - 当当前房间 `agents.len() == 1` 时，输入框上方/左侧默认显式固定 `@<唯一Agent名>` 标签（用户可直接输入内容回车发送，也可手动切换为 `@Manager` 招募第 2 个 Agent 升级为群聊）。
   - 当 `agents.len() >= 2` 时，输入 `@` 弹出成员与 `@Manager` 选择菜单，支持在一条消息中同时 `@` 多个 Agent。
2. **内部 Session 实时透视面板（只读 + 权限审批 + 紧急中止）**：
   - **严格只读限制**：透视面板仅展示该 Agent 底层 `ragents` Session 的内部事件流（`ModelReasoningDelta` 思考过程、`ModelTextDelta` 内部草稿、`ToolCallStarted/Finished` 工具调用参数与输出、`SessionCompacted` 压缩记录），**绝不提供私聊输入框**，确保所有交流全部回归聊天室。
   - **压缩血缘回溯器**：顶部展示该 Agent 经历过的压缩代数标签（如 `Gen 0 (已压缩)` $\rightarrow$ `Compact #1 (摘要会话)` $\rightarrow$ `Gen 1 (当前活跃)`），点击任意节点即可查看当时的完整原始上下文或压缩摘要。
   - **交互式权限审批卡片**：
     - 当底层 Session 触发 `PermissionRequested` 时，不仅右侧透视面板弹出审批卡片，聊天室中该 Agent 的状态徽章也会高亮显示 `🟠 等待权限审批`（点击直接定位到审批卡片）；
     - 支持查看 `original_path`、修改 `suggested_path`（自定义授权路径/域名通配符），并支持选择 5 级生效范围（`allow-once` / `allow-activation` / `allow-session` / `allow-workspace` / `allow-node`）或 `deny`；
     - 支持点击“紧急中止 (Cancel)”直接调用 `ragents-apiserver` 的 `cancel_activation` 中断卡死的任务。

### 7.3 `chatroom-server` REST & SSE 接口一览

| 分类 | 方法与路径 | 说明 |
| :--- | :--- | :--- |
| **房间管理** | `GET /api/v1/rooms` | 获取所有聊天室列表（含成员数、最新消息预览、各 Agent 状态） |
| | `POST /api/v1/rooms` | 创建新聊天室（自动创建 1 个默认 Agent 及其底层 `ragents` Session） |
| | `GET /api/v1/rooms/{room_id}` | 获取聊天室详情、成员列表与历史群消息 |
| | `DELETE /api/v1/rooms/{room_id}` | 删除聊天室（联动调用 `ragents-apiserver` 关闭所有成员的 Session 并回收后台进程） |
| **群消息与交互** | `POST /api/v1/rooms/{room_id}/messages` | 人类发送群消息（自动解析 `@`，触发 `@Manager`、目标 Agent 唤醒或空闲窥屏） |
| | `POST /api/v1/rooms/{room_id}/resume-relay` | 当触发连续 Agent 讨论上限暂停后，手动恢复讨论 |
| | `GET /api/v1/rooms/{room_id}/stream` (SSE) | 实时订阅房间内的群消息、成员状态变化、权限待审批提醒 |
| **群内 Agent 管理** | `POST /api/v1/rooms/{room_id}/agents` | 手动添加新 Agent 到聊天室（自动创建绑定 `ragents` Session） |
| | `POST /api/v1/rooms/{room_id}/recruit` | 直接请求 `@Manager` 根据自然语言描述生成并招募新 Agent |
| | `DELETE /api/v1/rooms/{room_id}/agents/{agent_id}` | 将某 Agent 移出聊天室（联动关闭其底层 `ragents` Session） |
| **内部透视与审批** | `GET /api/v1/agents/{agent_id}/inspector` | 获取该 Agent 当前及历史压缩链的 Session 上下文与事件历史 |
| | `GET /api/v1/agents/{agent_id}/inspector/stream` (SSE) | 实时透视该 Agent 内部 Session 的流式思考、工具调用与权限事件 |
| | `POST /api/v1/agents/{agent_id}/approve` | 批准或拒绝该 Agent 当前挂起的 `PermissionRequested`（支持 5 级周期与 `--path`） |
| | `POST /api/v1/agents/{agent_id}/cancel` | 紧急中止（Cancel）该 Agent 当前正在运行的 `Activation` |
| **Manager 设置** | `GET / PUT /api/v1/settings/manager` | 查看或更新 Manager 模型、提示词与新建 Agent 默认模板；同时返回集群可用节点与模型列表 |
| **认证与健康检查** | `GET /api/v1/auth/status` | 检查当前服务端是否开启鉴权及当前会话是否已认证 |
| | `POST /api/v1/auth/login` | 提交访问密钥/Token，校验通过后设置 `HttpOnly; SameSite=Strict` Cookie |
| | `POST /api/v1/auth/logout` | 清除认证 Cookie 并退出登录 |
| **WASM 内部回调** | `POST /api/v1/internal/agent-speak` | 供 `chatroom.wasm` 工具 `chatroom_speak` 回调（使用 Agent 专属 `agent_secret_token` 独立鉴权） |

---

## 8. 安全与鉴权体系设计（面向 VPS 公网部署）

为保障部署在 VPS 时的安全性，系统在 **`ragents-apiserver`** 与 **`ragents-chat`** 之间构建了三层职责分离的认证体系：

```text
  [浏览器用户 (Web UI)]
         │
         │ ① Web 访问认证 (Authorization: Bearer <CHAT_TOKEN> + HttpOnly Cookie 保护 REST & SSE)
         ▼
  [chatroom-server (VPS 对外服务端口)]
         │
         ├──► ② 控制面通信认证 (后端持有 RAGENTS_AUTH_TOKEN 请求 ragents-apiserver，对浏览器完全隐藏)
         │
         ▲
         │ ③ WASM 插件回调认证 (POST /api/v1/internal/agent-speak)
         │    每个 RoomAgent 持有唯一高熵 `agent_secret_token`，仅允许向所属房间发言
  [ragents-daemon / chatroom.wasm]
```

### 8.1 `ragents-apiserver` 认证插件设计 (`extensions/authn` $\rightarrow$ `ragent_authn_extension.wasm`)

1. **插件实现与职责**：
   - 在 `ragents/extensions/authn` 下新增标准控制面 WASM 认证插件 `ragent_authn_extension.wasm`，实现 `ragents-apiserver` 的 `AuthnPlugin` 接口契约（接收 `AuthnRequest { scope, method, path, headers }`，返回 `AuthnResponse`）。
   - 同时在 `ragents-apiserver` 内置快捷 Token 鉴权支持：既可以通过 `--authn-wasm <path>` 挂载 WASM 认证插件，也可以直接在启动 `ragents apiserver` / `ragents up` 时通过 `--auth-token <token>`（或环境变量 `RAGENTS_AUTH_TOKEN`）一键开启鉴权。
2. **支持多 Token 与作用域分离 (`AuthScope`)**：
   - 插件配置支持极简模式与多角色模式：
     ```json
     {
       "tokens": [
         {
           "token": "sk-ragents-admin-xxxx",
           "subject": "chatroom-server",
           "scopes": ["client_http", "daemon_tunnel"],
           "roles": ["admin"]
         },
         {
           "token": "sk-ragents-node-xxxx",
           "subject": "node-vps-01",
           "scopes": ["daemon_tunnel"],
           "roles": ["node"]
         }
       ]
     }
     ```
   - **`ClientHttp` 作用域**：拦截所有 `/api/v1/*` REST 与 `/api/v1/watch` SSE 请求，校验 `Authorization: Bearer <token>`（或 `X-Ragents-Token: <token>`）；
   - **`DaemonTunnel` 作用域**：拦截 `/api/v1/daemon/tunnel` WebSocket 握手请求，校验节点 `agent-daemon` 的 `Authorization: Bearer <token>`。
   - **恒定时间比较（Constant-Time Comparison）**：Token 比对采用防时序攻击的恒定时间字节比较，未携带或无效凭证一律返回 `401 Unauthorized`。

### 8.2 `ragents-chat` 三层认证机制设计

1. **第一层：Web 客户端 $\leftrightarrow$ `chatroom-server`（人类用户鉴权）**
   - **配置方式**：启动 `chatroom-server` 时通过 `--auth-token <CHAT_TOKEN>` 或环境变量 `RAGENTS_CHAT_AUTH_TOKEN` 配置访问口令。
   - **登录与双通道凭证（Header + HttpOnly Cookie）**：
     - 仅静态首页 `GET /`、`GET /api/v1/auth/status` 与 `POST /api/v1/auth/login` 免鉴权；
     - 当服务端开启了鉴权且请求未认证时，Web 前端自动展示**访问口令解锁界面**；
     - 用户输入口令调用 `POST /api/v1/auth/login` 验证通过后，服务端下发 `Set-Cookie: ragents_chat_token=<token>; HttpOnly; SameSite=Strict; Path=/`，同时前端支持在 REST 请求头携带 `Authorization: Bearer <token>`；
     - **解决原生 SSE 鉴权痛点**：由于浏览器原生 `EventSource`（用于订阅 `/api/v1/rooms/{id}/stream` 和 `/api/v1/agents/{id}/inspector/stream`）不支持自定义 Header，通过同源 `HttpOnly Cookie` 即可让所有 SSE 实时流与 REST 接口共享同一套严密的后端鉴权中间件，且无需在 URL Query 中暴露明文 Token。
2. **第二层：`chatroom-server` $\leftrightarrow$ `ragents-apiserver`（后端控制面鉴权）**
   - `chatroom-server` 在服务端内部通过 `RagentsClient::new(url).with_auth_token(...)` 携带 `RAGENTS_AUTH_TOKEN` 访问 `ragents-apiserver`；
   - 在单台 VPS 部署时，`ragents-apiserver` 可直接绑定在 `127.0.0.1:8080`（不暴露公网端口），仅将 `chatroom-server` 端口暴露给用户，且 `RAGENTS_AUTH_TOKEN` 绝不下发给浏览器前端。
3. **第三层：`chatroom.wasm` $\leftrightarrow$ `chatroom-server`（WASM 最小权限回调鉴权）**
   - 每个 `RoomAgent` 入群时，由 `chatroom-server` 生成唯一的随机 `agent_secret_token` 并写入该 Agent 的 `chatroom.wasm` 扩展配置；
   - 内部回调接口 `POST /api/v1/internal/agent-speak` 独立校验 `Authorization: Bearer <agent_secret_token>`：
     1. 必须精确匹配 `(room_id, agent_id, agent_secret_token)` 三元组；
     2. 必须满足该 Agent 当前轮次 `allow_speak_in_turn == 1`（未被禁言）；
     3. 该 Token **没有任何访问其他管理 API 或读取其他房间数据的权限**，做到最小权限隔离。

---

## 9. `ragents-chat/` 目录结构规划

```text
ragents-chat/
├── Cargo.toml                        # 独立 Workspace，通过 Git 仓库依赖 ragents/{ragents-protocol,ragents-client}
├── docs/
│   └── DESIGN.zh-CN.md               # 本设计文档
├── scripts/
│   └── build-chatroom-wasm.sh        # 编译 chatroom.wasm (wasm32-wasip2) 脚本
├── extensions/
│   └── chatroom/                     # 聊天室 WASM 插件 (ragent_chatroom_extension.wasm)
│       ├── Cargo.toml
│       └── src/lib.rs                # 实现 agent.prepare 群聊规则注入与 chatroom_speak 工具 (WASI 0.2 HTTP)
├── crates/
│   └── chatroom-server/              # 聊天室后端服务 + 静态内嵌 Web 前端
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs               # CLI 启动入口 (--bind, --db, --ragents-server)
│           ├── lib.rs
│           ├── store.rs              # SQLite 状态存储 (rooms, room_agents, room_messages, manager_settings)
│           ├── coordinator.rs        # 核心调度器：@ 唤醒、未读游标组装、空闲窥屏 (Idle Peek)、Session 压缩链追踪
│           ├── manager.rs            # @Manager 管家服务：调用 ragents-apiserver 生成并招募新 Agent
│           ├── http.rs               # REST API + 房间 SSE 流 + Agent 内部透视 SSE 流 + 权限审批/取消代理
│           └── web_assets.rs         # 内嵌单页 Web 前端资源
└── web/
    └── index.html                    # 现代化响应式 Web 客户端 (支持聊天室、@ 补全、Manager 配置、只读透视与权限审批)
```

---

## 10. 策略演进与多智能体协作调优记录 (Strategy Evolution & Tuning Log)

本节记录 `ragents-chat` 在真实多智能体协作场景（如多模型联合金融/期权策略分析、架构评审等）中发现的交互痛点、已实施的策略调整，以及**已提议但暂缓实施的备选策略**，供后续回顾与针对性微调。

---

### 10.1 已落地生效的策略调整

#### 1. 解耦「点名派活 (`mentions`)」与「正文提及 (`content`)」，消除双重 `@` 与误唤醒
* **背景现象**：
  * 模型在调用 `chatroom_speak` 时，经常既在 `mentions` 数组里填入 `["OptionStrategist", "Human"]`，又在 `content` 正文开头手写 `"@OptionStrategist 确认无误..."`，导致前端渲染出 `@OptionStrategist@Human@OptionStrategist` 的重复标签。
  * 更严重的是，旧逻辑使用 `parse_mentions(&req.content, &req.mentions, &agents)` 同时扫描正文中所有 `@Name`。当某个 Agent 在总结或致谢时在正文里写了 `"感谢 @LiquidityRiskAnalyst 的风控清单，我和 @OptionStrategist 已经对齐"`（甚至对 `@Manager` 说 `"收到，@Manager"`），会误把正文里的所有 `@Name` 当成显式点名（`Direct Mention`）全部唤醒。
* **已实施策略**：
  1. **人类发言 (`post_human_message`)**：保留从 `content` 正文解析 `@Name` 的能力（方便人类手打 `@Name` 点名）。
  2. **Agent 发言 (`handle_internal_agent_speak`)**：切换为 `resolve_explicit_mentions(&req.mentions, &agents, Some(&agent.name))`——**严格只认 `chatroom_speak` 工具显式传入的 `mentions` 数组**来触发后台唤醒，并自动过滤掉发言者自身（禁止自我 `@`）。正文中自然语言提到的 `@Name` 仅作为普通文本展示，绝不触发唤醒。
  3. **自动剥离冗余前缀与 UI 头部胶囊展示**：后端 `strip_leading_redundant_mentions` 与前端 `stripLeadingRedundantMentions` 自动剥离正文开头与 `mentions` 重复的 `@Name` 前缀；前端将 `mentions` 胶囊移至消息头部元信息栏（`#seq Sender ➔ @Target`）。

#### 2. 严格 `@` 纪律、禁止礼貌签收复读与禁止重复全文总结（`<chatroom_protocol>` 铁律）
* **背景现象**：
  * 多 Agent 协作收尾阶段容易陷入 `“确认无误 ✅ -> 收到签收，我也进入待命 ✅ -> 策略端同步静默待命 🎉”` 的无限礼貌客套循环。
  * 主控 Agent 在队友每次补充细节后，倾向于把几千字的完整方案换个标题重新发一遍（同一房间连发 4~5 版高度重合的“终极指南”）。
* **已实施策略**：
  1. **无任务不 `@`**：在 `<chatroom_protocol>` 与 `chatroom_speak.parameters.mentions` 描述中立下铁律——`mentions` 等同于立即派活指令，**只有明确要求某个 Agent 执行具体工作或回答问题时才允许将其放入 `mentions`**；向人类交付最终总结或仅仅引用/赞同队友时，`mentions` 只能填 `["Human"]` 或 `[]`。
  2. **严禁客套签收与允许静默结束 (`Observed.`)**：明确禁止发送“收到”、“已签收 ✅”、“待命”等无实质增量的消息；若任务已闭环，直接不调 `chatroom_speak`，以内部笔记 `Observed.` 结束回合。
  3. **只发增量、禁止全文复读**：明确告知所有历史消息对 `@Human` 与全员实时可见，补充观点时只写增量分析，禁止把前文已发过的完整方案重复抄写。

#### 3. 区分「人类点名」与「Agent 间点名」的未发言催促策略 (`DirectMentionState.from_human`)
* **背景现象**：
  * 旧逻辑对所有被 `Direct Mention` 唤醒却未调用 `chatroom_speak` 的 Agent 一律触发一次 `[System Reminder: ... Please call chatroom_speak]` 强制催促。当 Agent A 只是顺带 `@` 了 Agent B，Agent B 判断无需回复时，会被系统强行逼着发一条“收到，待命”。
* **已实施策略**：
  * 在 `DirectMentionState` 中记录 `from_human: bool`。
  * **仅当唤醒源来自人类 (`from_human == true`)** 且 Agent 漏调 `chatroom_speak` 时，才发送 `Auto-Nudge` 提醒；
  * **当唤醒源来自其他 Agent 或 `@Manager` (`from_human == false`)** 时，完全允许被 `@` 的 Agent 在判断无需补充后静默结束（`Observed.`），不再强制催促发言。

#### 4. 默认主导 Agent (`Default Room Lead`) 与 `@Manager` 招募交接优化
* **背景现象**：
  * 旧逻辑中，`@Manager` 招募完新专家后，在入群欢迎消息中同时 `@` 所有新招募的专家与原有成员，导致 3 个 Agent 在同一秒并发启动、各自闭门造车，输出大量交叉抢话与重复内容。
* **已实施策略**：
  1. **默认主导 Agent 规则**：当用户未显式指定主导 Agent 时，**房间内的第一个 Agent（按创建时间排序 `agents[0]`，例如建房时的初始 `@Assistant`）自动成为默认主导统筹 Agent (`[Default Room Lead]`)**，前端成员卡片显示 `👑 主导` 标记，群名册同步头 `[Room Roster Updated]` 也会向全体成员标明其主导身份。
  2. **`@Manager` 单点交接 (`handoff_lead`)**：当某个现有 Agent 呼叫 `@Manager` 招募新成员时，`@Manager` 招完人后**仅 `@` 呼叫它的主导 Agent**；当人类直接通过 `@Manager` 招募新成员时，`@Manager` **仅 `@` 房间内的第一个 Agent（默认主导 Agent）**（若招募前房间为空，则 `@` 新招募的第一位 Agent）。由主导 Agent 统一向新专家分配子任务，彻底消除入群时的全员并发抢话。

#### 5. 连续接力上限 (`max_agent_relay_depth`)、模型自动发现与推理参数配置
* **连续发言上限 (`max_agent_relay_depth`)**：改为房间级与全局级均可配置，**默认值为 `0`（`0` 表示不限制连续接力轮数）**；可在聊天室顶部栏实时调整。
* **`/v1/models` 自动发现 (`auto_discover_models = true`)**：`ragents-daemon` 启动时默认请求模型提供商的 `/v1/models` 接口拉取可用模型列表，`daemon.toml` 中显式配置的 `[models]` 作为补充与参数覆盖。
* **思考强度 (`effort`) 与思考摘要 (`summary`)**：支持在新建房间、手动添加 Agent、全局 Manager 设置以及右侧「内部透视」顶部栏实时切换 `model`、`reasoning_effort` (`none|low|medium|high|xhigh`) 与 `reasoning_summary` (`auto|concise|detailed`)。
* **无可用 Skill 时隐藏 `load_skill` 工具**：`ragent_skills_extension.wasm` 仅在扫描到至少一个可用 Skill（`!skills.is_empty()`）时才注册 `load_skill` 工具，并移除参数描述中硬编码的示例名，避免模型盲猜不存在的 Skill。

---

### 10.2 已提议但暂缓实施的备选策略（供后续观察与微调）

以下两项策略在复盘时提出，经评估后决定**暂不开启**，先观察上述 10.1 策略落地后的实际表现，若后续在极端场景下仍出现并发冗余可按需启用：

#### 备选策略 A：思考中防重入 / 未读 `@` 合并投递 (Thinking-State Direct-Mention Debounce)
* **问题描述**：
  当某个 Agent 正在 `Thinking`（处理上一条消息）时，若群内又产生了新的 `@` 它的消息，当前机制会立即通过 `push_realtime_message` 将新消息推入其正在运行的 Session Realtime Queue。这会使该 Agent 在当前 Activation 的下一个 Turn 立即看到新消息并可能再次调用 `chatroom_speak`（表现为同一个 Agent 连发两条针对不同问题的回复）。
* **为什么暂缓实施**：
  如果是针对多个不同问题的 `@`，允许 Agent 分别给出多个回答在群聊体验上完全合理，不算严重问题；过早防重入反而可能增加实时插话响应的延迟感。
* **未来如需开启的微调切入点**：
  在 `coordinator.rs` 的 `deliver_direct_mention_to_agent` 中检查 `target_agent.runtime_state`：若为 `AgentRuntimeState::Thinking`，仅标记 `pending_direct_mention = true` 而不立即调用 `push_realtime_message`；待 `on_agent_activation_finished` 触发时再一次性拉取 `last_delivered_seq..=last_msg_seq` 的全部未读消息合并投递。

#### 备选策略 B：单条消息多目标 `@` 顺序接力队列 (Sequential Multi-Mention Relay Queue)
* **问题描述**：
  当人类或主导 Agent 在同一条消息的 `mentions` 中同时填入多个专家（例如 `mentions: ["OptionStrategist", "LiquidityRiskAnalyst"]`）时，当前机制会并发唤醒这两个专家同时开始思考。由于思考期间彼此看不到对方尚未发出的草稿，若两人的职责边界有重叠，可能会写出部分重复的内容。
* **为什么暂缓实施**：
  1. 在分工明确的场景下（例如一个查数据、一个做风控），**并发执行能显著缩短整体等待时间（Latency 减半）**；
  2. 配合 10.1 中的“严禁重复全文总结”与“默认主导 Agent 分工”，角色职责正交时并发唤醒效率更高。
* **未来如需开启的微调切入点**：
  在 `RoomCoordinator` 中为房间增加可选开关 `sequential_mention_relay: bool`（默认 `false`）：当一条消息的 `mentions` 包含 $\ge 2$ 个 Agent 且开关开启时，先唤醒 `mentions[0]`，将其余 Agent 放入房间级 `pending_mention_queue`，在前一个 Agent 完成 `ActivationCompleted` 后自动唤醒下一个 Agent（此时下一个 Agent 的 `unread_messages` 已包含前一个 Agent 刚发出的回复，实现天然的上下文接力）。

