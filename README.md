# `ragents-chat` · 多智能体协同聊天室与全栈可插拔网关

`ragents-chat` 是基于 [`ragents`](https://github.com/rikaaa0928/ragents) 构建的 **AI 多智能体协同聊天室（Multi-Agent Chatroom）与实时透视控制台**。

它采用 **对底层 `ragents` 零业务侵入** 的设计理念：通过消费 `ragents` 的通用声明式原语（`Session`、`Activation`、`RealtimeQueue`、`SSE Watch`、`NodeExtensionCall`），配合部署在计算节点上的单个 `ragent_chatroom_extension.wasm` 插件，完整闭环实现单聊/群聊协同、`@Manager` 专家招募、房间级节点亲和与三层目录协同、跨公网高速文件暂存分发，以及底层 Session 的实时透视与权限管理。

---

## 1. 核心设计理念（Design Philosophy）

后续所有功能迭代均严格遵循以下 6 条核心设计理念：

### 1.1 对 `ragents` 核心零业务侵入 + 插件直连闭环
- **业务完全收敛于 `ragents-chat` 与 `ragent_chatroom_extension.wasm`**：`ragents` 核心组件（`apiserver` / `daemon` / `core` / `protocol`）不感知任何聊天室或文件管理业务概念。
- **插件直连 `ragents-chat` Server 绕过 `api-server`**：
  - 无论是在 Agent 激活执行期调用 `chatroom_speak` / `chatroom_add_agent`（`hook = "tools.call"`），还是在房间空闲期通过 `NodeExtensionCall` 按需唤醒节点插件浏览目录、上传或下载文件（`hook = "node.call"`），`ragent_chatroom_extension.wasm` 均在 WASI 0.2 沙箱内通过 `wasi:http` **直接与 `ragents-chat` Server 通信传输数据，彻底绕过 `ragents-apiserver`**。

### 1.2 跨公网文件「先服务器暂存、再节点分发/预载」传输模型
针对计算节点（如家庭内网 GPU 工作站）与公网服务器（`ragents-chat`）分离的跨 WAN 部署场景，彻底解耦浏览器传输与节点传输：
- **上传（浏览器 $\rightarrow$ `ragents-chat` 暂存区 $\rightarrow$ 节点 WASM 后台拉取）**：
  - 用户在聊天输入框粘贴/添加附件或在「文件穿透」面板点击上传时，浏览器通过 `PUT /api/v1/ext/workspace_fs/rooms/{room_id}/upload-raw` 将原始二进制流（零 Base64 膨胀）先直接写入 `ragents-chat` Server 本地暂存目录（`/tmp/ragents-chat-fs-stage/`，2 小时 TTL）。
  - 落盘服务器后立即触发后台任务，唤醒目标节点的 `ragent_chatroom_extension.wasm` 从 `ragents-chat` Server 的 `/internal-distribute/{dist_id}` 流式拉取文件并原子落盘至房间临时目录。
  - 聊天输入框与右侧文件面板均实时展示 **`📡 正在从服务器分发至节点 X%`** 进度条；若跨网波动导致分发失败，支持直接从服务器暂存区一键重试分发，无需浏览器重新上传。
- **下载与预览（节点 WASM 直推 $\rightarrow$ `ragents-chat` 暂存区 $\rightarrow$ 浏览器高速下载）**：
  - 节点的 `ragent_chatroom_extension.wasm` 将目标文件分块（`4 MB` 块）通过 HTTP `PUT /internal-stage/{stage_id}` 直推至 `ragents-chat` Server 本地暂存区，再由 `ragents-chat` Server 直接从本地磁盘高速流式响应给浏览器（`> 2 MB` 大文件在面板展示 `☁️ 预载` $\rightarrow$ `⏳ 预载 X%` $\rightarrow$ `⚡ 下载` 并自动触发浏览器下载）。

### 1.3 房间级计算亲和性与三层目录架构（Room Affinity & 3-Tier Directory）
- **`Pinned` 固定项目房间（`node:workspace_path`）**：
  - 严格绑定指定节点与项目工作目录，群内所有 Agent 共享 3 层受控目录：
    1. **项目工作目录（`workspace_root` / `.`）**
    2. **房间共享临时目录（`/tmp/ragents/rooms/<room_id>`，通过 `extra_tmp_dirs` 挂载）**
    3. **Agent 私有临时目录（`/tmp/ragents/sessions/<session_id>`，注入 `$TMPDIR`）**
  - 文件穿透面板提供「📂 工作目录」与「🗂️ 房间临时目录 (可上传)」双标签切换。
- **`Floating` 浮动房间（黏性节点绑定 + 自动/手动漂移）**：
  - 自动黏性绑定一台在线节点（Sticky Node Binding），将该节点的 `/tmp/ragents/rooms/<room_id>` 同时作为所有群内 Agent 的当前工作目录（`cwd`），使同一房间内的多个浮动 Agent 与文件面板天然共享同一目录。
  - 支持在顶栏手动切换绑定节点（漂移），并在原绑定节点离线且有新消息触发时自动容灾漂移至健康节点。

### 1.4 私密内部思考 vs 公开群聊发言 + 协议提示词沉降
- **1 Agent $\leftrightarrow$ 1 `ragents` `Session`**：Agent 内部的思维链、Shell 命令执行与文件读写完全隔离在其私有 Session 中，仅当显式调用 `chatroom_speak` 时才向聊天室投递公开消息。
- **发言协议沉降于 `<chatroom_protocol>` System Prompt**：完整的 `@Human` 与 `@Agent` 点名回复/终止规则统一注入在 `<chatroom_protocol>` 系统提示词中，日常消息体保持干净，不重复拼接长串协议指令（仅提供可选 `prompt_hint` 开关，默认关闭，供指令遵循较弱的小模型按需开启单行简短提醒）。
- **排队消息撤回、纯续跑重试与自治定时任务（`chatroom_schedule`）**：
  - 支持一键撤回尚在排队（未送入模型）的未读消息并自动回填输入框。
  - 当任务因网络或节点中断失败时，点击「直接重试」仅重发未读队列或提交纯 `Continuation` 激活（由 `api-server` 自动闭合未完成的 `FunctionCallOutput`），**绝不向历史上下文注入伪造的人工提示文本**。
  - 房间内每个工作 Agent 均具备 `chatroom_schedule` 工具，可根据用户自然语言指令自主创建、查看、暂停、恢复或删除定时任务（支持 `daily` 每日固定时间、`interval` 间隔轮询、`once` 单次延时、`cron` 5 段式表达式）；到点后自动携带 `<scheduled_task_trigger>` 唤醒该 Agent 的私有 Session 执行并在透视面板支持人类一键执行/暂停/删除。

### 1.5 全栈可插拔扩展架构（Backend API Gateway + Frontend UI Slots）
- 后端提供 `ChatServerExtension` 与 `/api/v1/ext/{plugin_id}/*` 路由网关，前端提供 `ExtensionSlotHost` 动态加载 ES Module 插件：
  - **`token_acl`**：多用户 Token 与房间级访问控制（Admin / Member）管理插件。
  - **`workspace_fs`**：远程节点工作区与房间临时目录穿透、在线预览、服务器暂存上传与大文件预载下载插件。

### 1.6 独立可折叠多栏 UI 与实时配置/权限透视
- 右侧面板（`流程轨迹`、`群成员`、`Agent Session 透视`、`文件穿透`）均为独立垂直分栏，默认收起、按需独立展开（移动端自适应为抽屉）。
- **Agent Session 透视面板（`RightInspectorPane`）**：
  - `ToolCall`、`WebSearch` 与结构化 `ToolResult` 采用无转义 YAML 块文本渲染，配有一键复制原始 `[JSON]` 按钮与精确到秒（`HH:mm:ss`）的卡片时间戳。
  - 实时展示四段式 System Prompt 快照、当前生效的模型与内置工具开关（如官方内置 `web_search`），以及当前实时生效的 **Agent 级、项目工作区级、节点级权限规则**，支持一键撤销任意非默认持久化授权规则。

---

## 2. 仓库结构

```text
ragents-chat/
├── Cargo.toml                        # Workspace 根配置
├── AGENTS.md                         # 开发规范与架构约束
├── Dockerfile                        # 生产环境多合一容器镜像构建定义
├── docker-compose.yml                # 三容器协同部署编排 (apiserver + daemon + chat)
├── scripts/
│   ├── build-chatroom-wasm.sh        # 编译 ragent_chatroom_extension.wasm (wasm32-wasip2)
│   └── prepare-bundle.sh             # 打包配置与全部 .wasm 插件至 ./bundle
├── wit/ragent-extension.wit          # WASM 扩展 WIT 接口契约
├── extensions/
│   └── chatroom/                     # ragent_chatroom_extension.wasm 源码 (chatroom_speak / add_agent / remove_agent + node.call 文件与 HTTP 直连传输)
├── crates/
│   └── chatroom-server/              # ragents-chat 后端服务：房间协调器、SSE 网关、SQLite 存储及 token_acl / workspace_fs 扩展
└── web/                              # React 19 + TypeScript + Tailwind CSS v4 + Vite 单文件前端工程
```

---

## 3. 编译与运行

### 3.1 编译前端、WASM 插件与后端二进制

```bash
# 1. 构建单文件前端产物 (web/dist/index.html)
cd web && npm install && npm run build && cd ..

# 2. 编译 ragent_chatroom_extension.wasm
./scripts/build-chatroom-wasm.sh

# 3. 编译 ragents-chat 服务端并运行端到端测试
cargo test --workspace
```

### 3.2 Docker Compose 一键部署

```bash
# 1. 准备 ./bundle 目录下的 daemon.toml 与所有 .wasm 扩展
./scripts/prepare-bundle.sh

# 2. 启动 ragents-apiserver、ragents-daemon 与 ragents-chat
RAGENTS_AUTH_TOKEN="<YOUR_CLUSTER_TOKEN>" \
RAGENTS_CHAT_AUTH_TOKEN="<YOUR_WEB_ADMIN_TOKEN>" \
RAGENTS_BASE_URL="https://your-openresponses-endpoint.example.com/v1" \
RAGENTS_API_KEY="<YOUR_API_KEY>" \
RAGENTS_MODEL="gemini-3.8-flash" \
docker compose up -d
```
