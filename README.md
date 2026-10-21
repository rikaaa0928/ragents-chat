# `ragents-chat` · 多智能体协同聊天室与 Session 实时透视系统

`ragents-chat` 是基于 [`ragents`](https://github.com/rikaaa0928/ragents) 构建的 **AI 多智能体协同聊天室（Multi-Agent Chatroom）**，采用零侵入插件架构，完整融合了单聊、群聊、聊天室管家（`@Manager`）动态招募、轮流窥屏与概率插嘴机制，以及底层 `ragents` Session 的实时只读透视与 5 级权限审批面板。

## 核心架构特性

1. **单聊与群聊统一模型（Unified Room Model）**：
   - 每个房间创建时默认包含 **1 个工作 Agent + 聊天室管家 `@Manager`**。
   - **单聊模式（房间内仅 1 个工作 Agent）**：前端与服务端自动显式附带 `@<唯一Agent>`。
   - **群聊模式（房间内 $\ge 2$ 个工作 Agent）**：用户可通过 `@Manager` 自然语言招募或手动添加任意数量的专家 Agent，无缝升级为多智能体群聊。
2. **1 Agent $\leftrightarrow$ 1 Session 强绑定与自动压缩血缘接力**：
   - 每个群内 Agent 对应一个持久化的 `ragents` `Session`。
   - 当底层触发三会话上下文自动压缩（`sess_1 -> sess_compact -> sess_2`）时，自动无缝切换至 `continued_session_id` 并保留完整血缘链。
3. **私密内部思考 vs 公开群聊发言（`chatroom.wasm`）**：
   - Agent 内部的思维链、草稿、Shell 执行与文件读写完全保存在其私有 Session 中，绝不污染群聊信息流。
   - 仅当 Agent 显式调用 `chatroom_speak` WASM 工具时，消息才通过 WASI 0.2 HTTP 投递至聊天室。
   - 若被显式 `@` 的 Agent 结束回合时忘记调用 `chatroom_speak`，协调器会自动触发一次轻量提醒（Auto-Nudge）。
4. **可实时调节的空闲窥屏与轮流概率插嘴（Sequential Roll & Interjection）**：
   - 房间顶部支持实时调节：**窥屏开关**、**静默触发秒数**、**消息轮次间隔**、**插嘴开关** 与 **禁言概率（`0~100%`）**。
   - 触发窥屏时，协调器为每个有未读消息的空闲 Agent 生成 `0~100` 随机数：
     - 低于禁言概率的 Agent 本轮进入只读禁言模式（`chatroom-server` 在调用 `push_realtime_message` 时原生传入 `disabled_tools: ["chatroom_speak"]`，由 `api-server` 与 `agent-core` 在激活级剥离发言工具）。
     - 高于等于禁言概率的 Agent 按随机数**从高到低依次轮流唤醒**；一旦首个 Agent 调用 `chatroom_speak` 插嘴发言，立即中断旧队列并基于新上下文开启下一轮判定，直至无人插嘴自然收敛。
5. **内部 Session 实时只读透视面板（Session Inspector）与三列可折叠布局**：
   - 右侧提供三个默认收起、可独立展开的垂直分栏：**流程轨迹（Flow Trace）**、**群成员（Roster）** 与 **具体 Agent 透视（Session Inspector）**。
   - 点击任意群内 Agent 即可实时透视其底层 `ragents` Session 的思维流、工具调用、压缩血缘切换（`Gen 0 -> Compact #1 -> Gen 1`）。
   - 支持**随时编辑并保存 `Client Prompt`（角色人设提示词，下一轮 Activation 立即生效）**，并可按段落折叠查看实时 **四段式 System Prompt (`PromptParts`) 快照**（`1. system_prompt` 集群级、`2. node_prompt` 节点级、`3. client_prompt` 角色级、`4. extension_prompts` 扩展级）及当前生效工具列表（`effective_tools`）。
   - 支持 **5 级权限交互式审批**（`AllowOnce` / `AllowActivation` / `AllowSession` / `AllowWorkspace` / `AllowNode` / `Deny` 及自定义 `--path` 覆盖，审批结果直接持久化至 `api-server`）与 **紧急中止执行**。
   - 严格只读：禁止在透视面板内私聊，所有对话统一在聊天室主窗口进行。
6. **三层远程部署鉴权（3-Tier Authn）**：
   - 浏览器 $\leftrightarrow$ `chatroom-server`：支持 `--auth-token` / `RAGENTS_CHAT_AUTH_TOKEN`（Bearer Header + `HttpOnly` Cookie）。
   - `chatroom-server` $\leftrightarrow$ `ragents-apiserver`：对接 `ragents` 内置的 `ragent_authn_extension.wasm` 控制面鉴权插件。
   - `chatroom.wasm` $\leftrightarrow$ `chatroom-server`：每个 Agent 独立签发 `agent_secret_token` 回调鉴权。

## 快速开始

### 方式一：Docker Compose 一键拉起纯净三容器环境（推荐）

`docker-compose.yml` 会启动三个独立容器（`ragents-apiserver`、`ragents-daemon`、`ragents-chat`），仅只读挂载 `./bundle:/etc/ragents:ro`（存放 `daemon.toml` 配置与 `.wasm` 插件），其余 SQLite 数据库、工作目录与临时文件均隔离在各自容器内部：

```bash
# 1. 准备配置文件与 WASM 插件包到 ./bundle
./scripts/prepare-bundle.sh

# 2. 启动三容器环境
RAGENTS_BASE_URL="http://host.docker.internal:8000/v1" \
RAGENTS_API_KEY="<YOUR_API_KEY>" \
RAGENTS_MODEL="gemini-3.8-flash" \
docker compose up -d --build

# 3. 浏览器打开 http://127.0.0.1:8090
```

### 方式二：本地直接运行

```bash
# 1. 编译 chatroom WASM 插件
./scripts/build-chatroom-wasm.sh

# 2. 启动 ragents 集群控制面与节点
# ragents up --auth-token <YOUR_CLUSTER_TOKEN> ...

# 3. 启动 ragents-chat 服务
RAGENTS_SERVER_URL="http://127.0.0.1:8080" \
RAGENTS_AUTH_TOKEN="<YOUR_CLUSTER_TOKEN>" \
RAGENTS_CHAT_AUTH_TOKEN="<YOUR_WEB_PASSWORD>" \
RAGENTS_MODEL="gemini-3.8-flash" \
cargo run -p chatroom-server -- --listen 127.0.0.1:8090
```

详细架构与接口设计请参阅 [`docs/DESIGN.zh-CN.md`](docs/DESIGN.zh-CN.md)。
