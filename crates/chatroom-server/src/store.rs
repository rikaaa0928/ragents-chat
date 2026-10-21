use crate::types::*;
use chrono::{DateTime, Utc};
use ragents_protocol::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ChatStoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
}

#[derive(Clone)]
pub struct ChatroomStore {
    conn: Arc<Mutex<Connection>>,
}

impl ChatroomStore {
    pub fn open(
        path: impl AsRef<Path>,
        default_model: &str,
        default_extensions: Vec<ExtensionSpec>,
    ) -> Result<Self, ChatStoreError> {
        if let Some(parent) = path.as_ref().parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn, default_model, default_extensions)
    }

    pub fn open_in_memory(
        default_model: &str,
        default_extensions: Vec<ExtensionSpec>,
    ) -> Result<Self, ChatStoreError> {
        let conn = Connection::open_in_memory()?;
        Self::from_connection(conn, default_model, default_extensions)
    }

    fn from_connection(
        conn: Connection,
        default_model: &str,
        default_extensions: Vec<ExtensionSpec>,
    ) -> Result<Self, ChatStoreError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;

             CREATE TABLE IF NOT EXISTS manager_settings (
                 id                        INTEGER PRIMARY KEY CHECK (id = 1),
                 manager_model             TEXT NOT NULL,
                 manager_system_prompt     TEXT NOT NULL,
                 default_node_id           TEXT,
                 default_workspace_root    TEXT,
                 default_agent_model       TEXT NOT NULL,
                 default_reasoning_effort  TEXT,
                 default_reasoning_summary TEXT,
                 default_web_search        INTEGER NOT NULL DEFAULT 0,
                 default_extensions_json   TEXT NOT NULL,
                 idle_peek_debounce_ms     INTEGER NOT NULL DEFAULT 800,
                 max_agent_relay_depth     INTEGER NOT NULL DEFAULT 0,
                 updated_at                TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS rooms (
                 room_id                 TEXT PRIMARY KEY,
                 name                    TEXT NOT NULL,
                 description             TEXT NOT NULL DEFAULT '',
                 node_id                 TEXT,
                 workspace_path          TEXT,
                 last_msg_seq            INTEGER NOT NULL DEFAULT 0,
                 roster_version          INTEGER NOT NULL DEFAULT 1,
                 peek_enabled            INTEGER NOT NULL DEFAULT 0,
                 peek_idle_secs          INTEGER NOT NULL DEFAULT 60,
                 peek_msg_interval       INTEGER NOT NULL DEFAULT 20,
                 interject_enabled       INTEGER NOT NULL DEFAULT 0,
                 mute_probability        INTEGER NOT NULL DEFAULT 40,
                 max_agent_relay_depth   INTEGER NOT NULL DEFAULT 0,
                 consecutive_agent_msgs  INTEGER NOT NULL DEFAULT 0,
                 created_at              TEXT NOT NULL,
                 updated_at              TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS room_agents (
                 agent_id                TEXT PRIMARY KEY,
                 room_id                 TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
                 name                    TEXT NOT NULL,
                 role_title              TEXT NOT NULL,
                 avatar                  TEXT NOT NULL,
                 persona_prompt          TEXT NOT NULL,
                 model                   TEXT NOT NULL,
                 reasoning_effort        TEXT,
                 reasoning_summary       TEXT,
                 web_search              INTEGER NOT NULL DEFAULT 0,
                 scheduling_json         TEXT NOT NULL,
                 root_session_id         TEXT NOT NULL,
                 active_session_id       TEXT NOT NULL,
                 session_chain_json      TEXT NOT NULL,
                 last_delivered_seq      INTEGER NOT NULL DEFAULT 0,
                 last_roster_version     INTEGER NOT NULL DEFAULT 0,
                 allow_speak_in_turn     INTEGER NOT NULL DEFAULT 1,
                 runtime_state           TEXT NOT NULL DEFAULT 'idle',
                 active_activation_id    TEXT,
                 agent_secret_token      TEXT NOT NULL,
                 created_by              TEXT NOT NULL,
                 created_at              TEXT NOT NULL,
                 UNIQUE (room_id, name)
             );
             CREATE INDEX IF NOT EXISTS idx_room_agents_room ON room_agents(room_id);
             CREATE INDEX IF NOT EXISTS idx_room_agents_active_session ON room_agents(active_session_id);

             CREATE TABLE IF NOT EXISTS room_messages (
                 room_id                 TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
                 msg_seq                 INTEGER NOT NULL,
                 message_id              TEXT NOT NULL UNIQUE,
                 sender_kind             TEXT NOT NULL,
                 sender_id               TEXT NOT NULL,
                 sender_name             TEXT NOT NULL,
                 content                 TEXT NOT NULL,
                 mentions_json           TEXT NOT NULL DEFAULT '[]',
                 visible_to_json         TEXT NOT NULL DEFAULT '[]',
                 reply_to_seq            INTEGER,
                 is_realtime             INTEGER NOT NULL DEFAULT 0,
                 source_session_id       TEXT,
                 source_activation_id    TEXT,
                 created_at              TEXT NOT NULL,
                 PRIMARY KEY (room_id, msg_seq)
             );",
        )?;

        let default_mgr_prompt = "You are @Manager, the AI Chatroom Butler and Team Architect. \
You manage the room's specialist agent roster using your tools:\n\
1. When asked to recruit/add new specialist agents, call `chatroom_add_agent` for each required agent FIRST (designing a clear nickname, role_title, emoji avatar, detailed persona_prompt, and choosing an appropriate model from Available Models).\n\
2. When asked to remove/dismiss existing agents, call `chatroom_remove_agent` FIRST.\n\
3. Wait until all `chatroom_add_agent` / `chatroom_remove_agent` tool calls have completed.\n\
4. Finally, call `chatroom_speak` ONCE to announce the roster changes in the chatroom and hand off task coordination ONLY to the Room Lead Agent (do not wake up all newly recruited agents simultaneously).";

        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR IGNORE INTO manager_settings (
                id, manager_model, manager_system_prompt, default_node_id, default_workspace_root,
                default_agent_model, default_extensions_json, idle_peek_debounce_ms, max_agent_relay_depth, updated_at
            ) VALUES (1, ?1, ?2, NULL, NULL, ?1, ?3, 800, 0, ?4)",
            params![
                default_model,
                default_mgr_prompt,
                serde_json::to_string(&default_extensions)?,
                now,
            ],
        )?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn get_manager_settings(&self) -> Result<ManagerSettings, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let row = conn.query_row(
            "SELECT manager_model, manager_system_prompt, default_node_id, default_workspace_root,
                    default_agent_model, default_reasoning_effort, default_reasoning_summary,
                    default_web_search, default_extensions_json, idle_peek_debounce_ms, max_agent_relay_depth, updated_at
             FROM manager_settings WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, i64>(7)? != 0,
                    r.get::<_, String>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, String>(11)?,
                ))
            },
        )?;

        Ok(ManagerSettings {
            manager_model: row.0,
            manager_system_prompt: row.1,
            default_node_id: row.2,
            default_workspace_root: row.3,
            default_agent_model: row.4,
            default_reasoning_effort: row.5,
            default_reasoning_summary: row.6,
            default_web_search: row.7,
            default_extensions: serde_json::from_str(&row.8).unwrap_or_default(),
            idle_peek_debounce_ms: row.9 as u64,
            max_agent_relay_depth: row.10 as u32,
            updated_at: parse_dt(&row.11),
        })
    }

    pub fn update_manager_settings(
        &self,
        patch: UpdateManagerSettingsRequest,
    ) -> Result<ManagerSettings, ChatStoreError> {
        let mut current = self.get_manager_settings()?;
        if let Some(m) = patch.manager_model {
            current.manager_model = m;
        }
        if let Some(p) = patch.manager_system_prompt {
            current.manager_system_prompt = p;
        }
        if let Some(n) = patch.default_node_id {
            current.default_node_id = n.filter(|s| !s.trim().is_empty());
        }
        if let Some(w) = patch.default_workspace_root {
            current.default_workspace_root = w.filter(|s| !s.trim().is_empty());
        }
        if let Some(am) = patch.default_agent_model {
            current.default_agent_model = am;
        }
        if let Some(eff) = patch.default_reasoning_effort {
            current.default_reasoning_effort = eff.filter(|s| !s.trim().is_empty());
        }
        if let Some(sum) = patch.default_reasoning_summary {
            current.default_reasoning_summary = sum.filter(|s| !s.trim().is_empty());
        }
        if let Some(ws) = patch.default_web_search {
            current.default_web_search = ws;
        }
        if let Some(exts) = patch.default_extensions {
            current.default_extensions = exts;
        }
        if let Some(ms) = patch.idle_peek_debounce_ms {
            current.idle_peek_debounce_ms = ms;
        }
        if let Some(depth) = patch.max_agent_relay_depth {
            current.max_agent_relay_depth = depth;
        }
        current.updated_at = Utc::now();

        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE manager_settings SET
                manager_model = ?1,
                manager_system_prompt = ?2,
                default_node_id = ?3,
                default_workspace_root = ?4,
                default_agent_model = ?5,
                default_reasoning_effort = ?6,
                default_reasoning_summary = ?7,
                default_web_search = ?8,
                default_extensions_json = ?9,
                idle_peek_debounce_ms = ?10,
                max_agent_relay_depth = ?11,
                updated_at = ?12
             WHERE id = 1",
            params![
                &current.manager_model,
                &current.manager_system_prompt,
                &current.default_node_id,
                &current.default_workspace_root,
                &current.default_agent_model,
                &current.default_reasoning_effort,
                &current.default_reasoning_summary,
                i64::from(current.default_web_search),
                serde_json::to_string(&current.default_extensions)?,
                current.idle_peek_debounce_ms as i64,
                current.max_agent_relay_depth as i64,
                current.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(current)
    }

    pub fn create_room(&self, name: &str, description: &str) -> Result<Room, ChatStoreError> {
        let mgr = self.get_manager_settings()?;
        let room_id = format!("room_{}", Uuid::now_v7());
        let now = Utc::now();
        let room = Room {
            room_id: room_id.clone(),
            name: name.to_string(),
            description: description.to_string(),
            node_id: None,
            workspace_path: None,
            last_msg_seq: 0,
            roster_version: 1,
            peek_enabled: false,
            peek_idle_secs: 60,
            peek_msg_interval: 20,
            interject_enabled: false,
            mute_probability: 40,
            max_agent_relay_depth: mgr.max_agent_relay_depth,
            consecutive_agent_msgs: 0,
            created_at: now,
            updated_at: now,
        };

        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "INSERT INTO rooms (
                room_id, name, description, node_id, workspace_path, last_msg_seq, roster_version,
                peek_enabled, peek_idle_secs, peek_msg_interval, interject_enabled,
                mute_probability, max_agent_relay_depth, consecutive_agent_msgs,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, NULL, NULL, 0, 1, 0, 60, 20, 0, 40, ?4, 0, ?5, ?5)",
            params![
                &room.room_id,
                &room.name,
                &room.description,
                room.max_agent_relay_depth as i64,
                now.to_rfc3339(),
            ],
        )?;
        Ok(room)
    }

    pub fn set_room_binding(
        &self,
        room_id: &str,
        node_id: Option<&str>,
        workspace_path: Option<&str>,
    ) -> Result<(), ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE rooms SET node_id = ?1, workspace_path = ?2 WHERE room_id = ?3",
            params![node_id, workspace_path, room_id],
        )?;
        Ok(())
    }

    pub fn get_room(&self, room_id: &str) -> Result<Option<Room>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        Self::load_room_from_conn(&conn, room_id)
    }

    fn load_room_from_conn(conn: &Connection, room_id: &str) -> Result<Option<Room>, ChatStoreError> {
        conn.query_row(
            "SELECT room_id, name, description, last_msg_seq, roster_version,
                    peek_enabled, peek_idle_secs, peek_msg_interval, interject_enabled,
                    mute_probability, max_agent_relay_depth, consecutive_agent_msgs,
                    created_at, updated_at, node_id, workspace_path
             FROM rooms WHERE room_id = ?1",
            params![room_id],
            |r| {
                Ok(Room {
                    room_id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    node_id: r.get(14)?,
                    workspace_path: r.get(15)?,
                    last_msg_seq: r.get::<_, i64>(3)? as u64,
                    roster_version: r.get::<_, i64>(4)? as u64,
                    peek_enabled: r.get::<_, i64>(5)? != 0,
                    peek_idle_secs: r.get::<_, i64>(6)? as u64,
                    peek_msg_interval: r.get::<_, i64>(7)? as u32,
                    interject_enabled: r.get::<_, i64>(8)? != 0,
                    mute_probability: (r.get::<_, i64>(9)?.clamp(0, 100)) as u8,
                    max_agent_relay_depth: r.get::<_, i64>(10)? as u32,
                    consecutive_agent_msgs: r.get::<_, i64>(11)? as u32,
                    created_at: parse_dt(&r.get::<_, String>(12)?),
                    updated_at: parse_dt(&r.get::<_, String>(13)?),
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_rooms(&self) -> Result<Vec<Room>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT room_id, name, description, last_msg_seq, roster_version,
                    peek_enabled, peek_idle_secs, peek_msg_interval, interject_enabled,
                    mute_probability, max_agent_relay_depth, consecutive_agent_msgs,
                    created_at, updated_at, node_id, workspace_path
             FROM rooms ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Room {
                room_id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                node_id: r.get(14)?,
                workspace_path: r.get(15)?,
                last_msg_seq: r.get::<_, i64>(3)? as u64,
                roster_version: r.get::<_, i64>(4)? as u64,
                peek_enabled: r.get::<_, i64>(5)? != 0,
                peek_idle_secs: r.get::<_, i64>(6)? as u64,
                peek_msg_interval: r.get::<_, i64>(7)? as u32,
                interject_enabled: r.get::<_, i64>(8)? != 0,
                mute_probability: (r.get::<_, i64>(9)?.clamp(0, 100)) as u8,
                max_agent_relay_depth: r.get::<_, i64>(10)? as u32,
                consecutive_agent_msgs: r.get::<_, i64>(11)? as u32,
                created_at: parse_dt(&r.get::<_, String>(12)?),
                updated_at: parse_dt(&r.get::<_, String>(13)?),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn patch_room(&self, room_id: &str, patch: PatchRoomRequest) -> Result<Room, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut room = Self::load_room_from_conn(&conn, room_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("room {room_id}")))?;

        if let Some(name) = patch.name {
            room.name = name;
        }
        if let Some(desc) = patch.description {
            room.description = desc;
        }
        if let Some(pe) = patch.peek_enabled {
            room.peek_enabled = pe;
        }
        if let Some(secs) = patch.peek_idle_secs {
            room.peek_idle_secs = secs;
        }
        if let Some(interval) = patch.peek_msg_interval {
            room.peek_msg_interval = interval.max(1);
        }
        if let Some(ie) = patch.interject_enabled {
            room.interject_enabled = ie;
        }
        if let Some(mp) = patch.mute_probability {
            room.mute_probability = mp.min(100);
        }
        if let Some(depth) = patch.max_agent_relay_depth {
            room.max_agent_relay_depth = depth;
        }
        room.updated_at = Utc::now();

        conn.execute(
            "UPDATE rooms SET
                name = ?1,
                description = ?2,
                peek_enabled = ?3,
                peek_idle_secs = ?4,
                peek_msg_interval = ?5,
                interject_enabled = ?6,
                mute_probability = ?7,
                max_agent_relay_depth = ?8,
                updated_at = ?9
             WHERE room_id = ?10",
            params![
                &room.name,
                &room.description,
                i64::from(room.peek_enabled),
                room.peek_idle_secs as i64,
                room.peek_msg_interval as i64,
                i64::from(room.interject_enabled),
                room.mute_probability as i64,
                room.max_agent_relay_depth as i64,
                room.updated_at.to_rfc3339(),
                room_id,
            ],
        )?;
        Ok(room)
    }

    pub fn reset_consecutive_agent_msgs(&self, room_id: &str) -> Result<Room, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE rooms SET consecutive_agent_msgs = 0, updated_at = ?1 WHERE room_id = ?2",
            params![Utc::now().to_rfc3339(), room_id],
        )?;
        Self::load_room_from_conn(&conn, room_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("room {room_id}")))
    }

    pub fn delete_room(&self, room_id: &str) -> Result<Vec<RoomAgent>, ChatStoreError> {
        let mut agents = self.list_room_agents(room_id)?;
        if let Ok(Some(mgr)) = self.get_room_manager_agent(room_id) {
            agents.push(mgr);
        }
        let conn = self.conn.lock().expect("store mutex poisoned");
        let affected = conn.execute("DELETE FROM rooms WHERE room_id = ?1", params![room_id])?;
        if affected == 0 {
            return Err(ChatStoreError::NotFound(format!("room {room_id}")));
        }
        Ok(agents)
    }

    pub fn insert_agent(&self, mut agent: RoomAgent) -> Result<(RoomAgent, Room), ChatStoreError> {
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        let tx = conn.transaction()?;

        let mut room = Self::load_room_from_conn(&tx, &agent.room_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("room {}", agent.room_id)))?;

        if !agent.name.eq_ignore_ascii_case("Manager") {
            room.roster_version += 1;
        }
        room.updated_at = Utc::now();
        agent.last_delivered_seq = room.last_msg_seq;

        tx.execute(
            "UPDATE rooms SET roster_version = ?1, updated_at = ?2 WHERE room_id = ?3",
            params![
                room.roster_version as i64,
                room.updated_at.to_rfc3339(),
                &room.room_id,
            ],
        )?;

        tx.execute(
            "INSERT INTO room_agents (
                agent_id, room_id, name, role_title, avatar, persona_prompt,
                model, reasoning_effort, reasoning_summary, web_search, scheduling_json,
                root_session_id, active_session_id,
                session_chain_json, last_delivered_seq, last_roster_version,
                allow_speak_in_turn, runtime_state, active_activation_id,
                agent_secret_token, created_by, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                &agent.agent_id,
                &agent.room_id,
                &agent.name,
                &agent.role_title,
                &agent.avatar,
                &agent.persona_prompt,
                &agent.model,
                &agent.reasoning_effort,
                &agent.reasoning_summary,
                i64::from(agent.web_search),
                serde_json::to_string(&agent.scheduling)?,
                agent.root_session_id.as_str(),
                agent.active_session_id.as_str(),
                serde_json::to_string(&agent.session_chain)?,
                agent.last_delivered_seq as i64,
                agent.last_roster_version as i64,
                i64::from(agent.allow_speak_in_turn),
                agent.runtime_state.as_str(),
                agent.active_activation_id.as_ref().map(|a| a.as_str()),
                &agent.agent_secret_token,
                &agent.created_by,
                agent.created_at.to_rfc3339(),
            ],
        )?;

        tx.commit()?;
        Ok((agent, room))
    }

    fn row_to_agent(r: &rusqlite::Row<'_>) -> rusqlite::Result<RoomAgent> {
        let scheduling_str: String = r.get(10)?;
        let chain_str: String = r.get(13)?;
        let state_str: String = r.get(17)?;
        let act_opt: Option<String> = r.get(18)?;
        let created_str: String = r.get(21)?;
        Ok(RoomAgent {
            agent_id: r.get(0)?,
            room_id: r.get(1)?,
            name: r.get(2)?,
            role_title: r.get(3)?,
            avatar: r.get(4)?,
            persona_prompt: r.get(5)?,
            model: r.get(6)?,
            reasoning_effort: r.get(7)?,
            reasoning_summary: r.get(8)?,
            web_search: r.get::<_, i64>(9)? != 0,
            scheduling: serde_json::from_str(&scheduling_str).unwrap_or(SchedulingMode::Floating {
                node_selector: Default::default(),
            }),
            root_session_id: SessionId::new(r.get::<_, String>(11)?),
            active_session_id: SessionId::new(r.get::<_, String>(12)?),
            session_chain: serde_json::from_str(&chain_str).unwrap_or_default(),
            last_delivered_seq: r.get::<_, i64>(14)? as u64,
            last_roster_version: r.get::<_, i64>(15)? as u64,
            allow_speak_in_turn: r.get::<_, i64>(16)? != 0,
            runtime_state: AgentRuntimeState::from_str(&state_str),
            active_activation_id: act_opt.map(ActivationId::new),
            agent_secret_token: r.get(19)?,
            created_by: r.get(20)?,
            created_at: parse_dt(&created_str),
        })
    }

    pub fn list_room_agents(&self, room_id: &str) -> Result<Vec<RoomAgent>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT agent_id, room_id, name, role_title, avatar, persona_prompt,
                    model, reasoning_effort, reasoning_summary, web_search, scheduling_json,
                    root_session_id, active_session_id,
                    session_chain_json, last_delivered_seq, last_roster_version,
                    allow_speak_in_turn, runtime_state, active_activation_id,
                    agent_secret_token, created_by, created_at
             FROM room_agents WHERE room_id = ?1 AND lower(name) != 'manager' ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![room_id], Self::row_to_agent)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_room_manager_agent(
        &self,
        room_id: &str,
    ) -> Result<Option<RoomAgent>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.query_row(
            "SELECT agent_id, room_id, name, role_title, avatar, persona_prompt,
                    model, reasoning_effort, reasoning_summary, web_search, scheduling_json,
                    root_session_id, active_session_id,
                    session_chain_json, last_delivered_seq, last_roster_version,
                    allow_speak_in_turn, runtime_state, active_activation_id,
                    agent_secret_token, created_by, created_at
             FROM room_agents WHERE room_id = ?1 AND lower(name) = 'manager' LIMIT 1",
            params![room_id],
            Self::row_to_agent,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn get_agent(&self, agent_id: &str) -> Result<Option<RoomAgent>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.query_row(
            "SELECT agent_id, room_id, name, role_title, avatar, persona_prompt,
                    model, reasoning_effort, reasoning_summary, web_search, scheduling_json,
                    root_session_id, active_session_id,
                    session_chain_json, last_delivered_seq, last_roster_version,
                    allow_speak_in_turn, runtime_state, active_activation_id,
                    agent_secret_token, created_by, created_at
             FROM room_agents WHERE agent_id = ?1",
            params![agent_id],
            Self::row_to_agent,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn get_agent_by_session(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<RoomAgent>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.query_row(
            "SELECT agent_id, room_id, name, role_title, avatar, persona_prompt,
                    model, reasoning_effort, reasoning_summary, web_search, scheduling_json,
                    root_session_id, active_session_id,
                    session_chain_json, last_delivered_seq, last_roster_version,
                    allow_speak_in_turn, runtime_state, active_activation_id,
                    agent_secret_token, created_by, created_at
             FROM room_agents WHERE active_session_id = ?1",
            params![session_id.as_str()],
            Self::row_to_agent,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn update_agent_model_and_reasoning(
        &self,
        agent_id: &str,
        patch: PatchAgentRequest,
    ) -> Result<RoomAgent, ChatStoreError> {
        let mut agent = self
            .get_agent(agent_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("agent {agent_id}")))?;
        if let Some(rt) = patch.role_title {
            if !rt.trim().is_empty() {
                agent.role_title = rt.trim().to_string();
            }
        }
        if let Some(pp) = patch.persona_prompt {
            if !pp.trim().is_empty() {
                agent.persona_prompt = pp.trim().to_string();
            }
        }
        if let Some(m) = patch.model {
            if !m.trim().is_empty() {
                agent.model = m.trim().to_string();
            }
        }
        if let Some(eff) = patch.reasoning_effort {
            agent.reasoning_effort = eff.filter(|s| !s.trim().is_empty());
        }
        if let Some(sum) = patch.reasoning_summary {
            agent.reasoning_summary = sum.filter(|s| !s.trim().is_empty());
        }
        if let Some(ws) = patch.web_search {
            agent.web_search = ws;
        }
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE room_agents SET role_title = ?1, persona_prompt = ?2, model = ?3, reasoning_effort = ?4, reasoning_summary = ?5, web_search = ?6 WHERE agent_id = ?7",
            params![
                &agent.role_title,
                &agent.persona_prompt,
                &agent.model,
                &agent.reasoning_effort,
                &agent.reasoning_summary,
                i64::from(agent.web_search),
                agent_id,
            ],
        )?;
        Ok(agent)
    }

    pub fn remove_agent(&self, room_id: &str, agent_id: &str) -> Result<RoomAgent, ChatStoreError> {
        let existing = self
            .get_agent(agent_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("agent {agent_id}")))?;
        if existing.room_id != room_id {
            return Err(ChatStoreError::NotFound(format!(
                "agent {agent_id} in room {room_id}"
            )));
        }
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM room_agents WHERE agent_id = ?1 AND room_id = ?2",
            params![agent_id, room_id],
        )?;
        tx.execute(
            "UPDATE rooms SET roster_version = roster_version + 1, updated_at = ?1 WHERE room_id = ?2",
            params![Utc::now().to_rfc3339(), room_id],
        )?;
        tx.commit()?;
        Ok(existing)
    }

    pub fn update_agent_runtime_state(
        &self,
        agent_id: &str,
        state: AgentRuntimeState,
        active_activation_id: Option<ActivationId>,
    ) -> Result<RoomAgent, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE room_agents SET runtime_state = ?1, active_activation_id = ?2 WHERE agent_id = ?3",
            params![
                state.as_str(),
                active_activation_id.as_ref().map(|a| a.as_str()),
                agent_id,
            ],
        )?;
        drop(conn);
        self.get_agent(agent_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("agent {agent_id}")))
    }

    pub fn update_agent_compaction(
        &self,
        agent_id: &str,
        compaction_session_id: SessionId,
        continued_session_id: SessionId,
        continued_activation_id: ActivationId,
        generation: u32,
        tokens_before: u64,
    ) -> Result<RoomAgent, ChatStoreError> {
        let mut agent = self
            .get_agent(agent_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("agent {agent_id}")))?;
        agent.active_session_id = continued_session_id.clone();
        agent.active_activation_id = Some(continued_activation_id.clone());
        agent.session_chain.push(SessionChainEntry {
            generation,
            working_session_id: continued_session_id.clone(),
            compaction_session_id: Some(compaction_session_id),
            tokens_before: Some(tokens_before),
            created_at: Utc::now(),
        });

        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE room_agents SET active_session_id = ?1, active_activation_id = ?2, session_chain_json = ?3 WHERE agent_id = ?4",
            params![
                continued_session_id.as_str(),
                continued_activation_id.as_str(),
                serde_json::to_string(&agent.session_chain)?,
                agent_id,
            ],
        )?;
        Ok(agent)
    }

    pub fn prepare_agent_delivery(
        &self,
        agent_id: &str,
        delivered_seq: u64,
        roster_version: u64,
        allow_speak: bool,
    ) -> Result<RoomAgent, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE room_agents SET
                last_delivered_seq = MAX(last_delivered_seq, ?1),
                last_roster_version = MAX(last_roster_version, ?2),
                allow_speak_in_turn = ?3
             WHERE agent_id = ?4",
            params![
                delivered_seq as i64,
                roster_version as i64,
                i64::from(allow_speak),
                agent_id,
            ],
        )?;
        drop(conn);
        self.get_agent(agent_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("agent {agent_id}")))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn append_message(
        &self,
        room_id: &str,
        sender_kind: SenderKind,
        sender_id: &str,
        sender_name: &str,
        content: String,
        mentions: Vec<String>,
        visible_to: Vec<String>,
        reply_to_seq: Option<u64>,
        is_realtime: bool,
        source_session_id: Option<SessionId>,
        source_activation_id: Option<ActivationId>,
    ) -> Result<(RoomMessage, Room), ChatStoreError> {
        let mut conn = self.conn.lock().expect("store mutex poisoned");
        let tx = conn.transaction()?;

        let mut room = Self::load_room_from_conn(&tx, room_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("room {room_id}")))?;

        room.last_msg_seq += 1;
        room.updated_at = Utc::now();
        match sender_kind {
            SenderKind::Human => room.consecutive_agent_msgs = 0,
            SenderKind::Agent => room.consecutive_agent_msgs += 1,
            SenderKind::Manager | SenderKind::System => {}
        }

        tx.execute(
            "UPDATE rooms SET last_msg_seq = ?1, consecutive_agent_msgs = ?2, updated_at = ?3 WHERE room_id = ?4",
            params![
                room.last_msg_seq as i64,
                room.consecutive_agent_msgs as i64,
                room.updated_at.to_rfc3339(),
                room_id,
            ],
        )?;

        let msg = RoomMessage {
            room_id: room_id.to_string(),
            msg_seq: room.last_msg_seq,
            message_id: format!("msg_{}", Uuid::now_v7()),
            sender_kind,
            sender_id: sender_id.to_string(),
            sender_name: sender_name.to_string(),
            content,
            mentions,
            visible_to,
            reply_to_seq,
            is_realtime,
            source_session_id,
            source_activation_id,
            created_at: room.updated_at,
        };

        tx.execute(
            "INSERT INTO room_messages (
                room_id, msg_seq, message_id, sender_kind, sender_id, sender_name,
                content, mentions_json, visible_to_json, reply_to_seq, is_realtime, source_session_id, source_activation_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                &msg.room_id,
                msg.msg_seq as i64,
                &msg.message_id,
                msg.sender_kind.as_str(),
                &msg.sender_id,
                &msg.sender_name,
                &msg.content,
                serde_json::to_string(&msg.mentions)?,
                serde_json::to_string(&msg.visible_to)?,
                msg.reply_to_seq.map(|s| s as i64),
                i64::from(msg.is_realtime),
                msg.source_session_id.as_ref().map(|s| s.as_str()),
                msg.source_activation_id.as_ref().map(|a| a.as_str()),
                msg.created_at.to_rfc3339(),
            ],
        )?;

        // If an Agent sent this message, advance its own `last_delivered_seq` if it had already read up to `msg_seq - 1`
        if sender_kind == SenderKind::Agent {
            tx.execute(
                "UPDATE room_agents SET last_delivered_seq = ?1
                 WHERE agent_id = ?2 AND last_delivered_seq = ?3",
                params![
                    msg.msg_seq as i64,
                    sender_id,
                    (msg.msg_seq - 1) as i64,
                ],
            )?;
        }

        tx.commit()?;
        Ok((msg, room))
    }

    pub fn list_room_messages(
        &self,
        room_id: &str,
        after_seq: u64,
    ) -> Result<Vec<RoomMessage>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT room_id, msg_seq, message_id, sender_kind, sender_id, sender_name,
                    content, mentions_json, visible_to_json, reply_to_seq, is_realtime, source_session_id, source_activation_id, created_at
             FROM room_messages WHERE room_id = ?1 AND msg_seq > ?2 ORDER BY msg_seq ASC",
        )?;
        let rows = stmt.query_map(params![room_id, after_seq as i64], |r| {
            let mentions_str: String = r.get(7)?;
            let visible_str: String = r.get(8)?;
            Ok(RoomMessage {
                room_id: r.get(0)?,
                msg_seq: r.get::<_, i64>(1)? as u64,
                message_id: r.get(2)?,
                sender_kind: SenderKind::from_str(&r.get::<_, String>(3)?),
                sender_id: r.get(4)?,
                sender_name: r.get(5)?,
                content: r.get(6)?,
                mentions: serde_json::from_str(&mentions_str).unwrap_or_default(),
                visible_to: serde_json::from_str(&visible_str).unwrap_or_default(),
                reply_to_seq: r.get::<_, Option<i64>>(9)?.map(|s| s as u64),
                is_realtime: r.get::<_, i64>(10).unwrap_or(0) != 0,
                source_session_id: r.get::<_, Option<String>>(11)?.map(SessionId::new),
                source_activation_id: r.get::<_, Option<String>>(12)?.map(ActivationId::new),
                created_at: parse_dt(&r.get::<_, String>(13)?),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Returns unread room messages after `after_seq` filtered by `visible_to` for `agent_name`:
    /// - Messages with `visible_to.is_empty()` are public to all agents.
    /// - Messages with non-empty `visible_to` are visible ONLY to their sender (`sender_name`) and
    ///   agents explicitly listed in `visible_to`.
    pub fn list_room_messages_for_agent(
        &self,
        room_id: &str,
        after_seq: u64,
        agent_name: &str,
    ) -> Result<Vec<RoomMessage>, ChatStoreError> {
        let all = self.list_room_messages(room_id, after_seq)?;
        Ok(all
            .into_iter()
            .filter(|m| {
                m.visible_to.is_empty()
                    || m.sender_name.eq_ignore_ascii_case(agent_name)
                    || m.visible_to
                        .iter()
                        .any(|v| v.eq_ignore_ascii_case(agent_name))
            })
            .collect())
    }

    pub fn set_agent_last_delivered_seq(
        &self,
        agent_id: &str,
        delivered_seq: u64,
    ) -> Result<RoomAgent, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "UPDATE room_agents SET last_delivered_seq = ?1 WHERE agent_id = ?2",
            params![delivered_seq as i64, agent_id],
        )?;
        drop(conn);
        self.get_agent(agent_id)?
            .ok_or_else(|| ChatStoreError::NotFound(format!("agent {agent_id}")))
    }

    pub fn get_room_message(
        &self,
        room_id: &str,
        msg_seq: u64,
    ) -> Result<Option<RoomMessage>, ChatStoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.query_row(
            "SELECT room_id, msg_seq, message_id, sender_kind, sender_id, sender_name,
                    content, mentions_json, visible_to_json, reply_to_seq, is_realtime, source_session_id, source_activation_id, created_at
             FROM room_messages WHERE room_id = ?1 AND msg_seq = ?2",
            params![room_id, msg_seq as i64],
            |r| {
                let mentions_str: String = r.get(7)?;
                let visible_str: String = r.get(8)?;
                Ok(RoomMessage {
                    room_id: r.get(0)?,
                    msg_seq: r.get::<_, i64>(1)? as u64,
                    message_id: r.get(2)?,
                    sender_kind: SenderKind::from_str(&r.get::<_, String>(3)?),
                    sender_id: r.get(4)?,
                    sender_name: r.get(5)?,
                    content: r.get(6)?,
                    mentions: serde_json::from_str(&mentions_str).unwrap_or_default(),
                    visible_to: serde_json::from_str(&visible_str).unwrap_or_default(),
                    reply_to_seq: r.get::<_, Option<i64>>(9)?.map(|s| s as u64),
                    is_realtime: r.get::<_, i64>(10).unwrap_or(0) != 0,
                    source_session_id: r.get::<_, Option<String>>(11)?.map(SessionId::new),
                    source_activation_id: r.get::<_, Option<String>>(12)?.map(ActivationId::new),
                    created_at: parse_dt(&r.get::<_, String>(13)?),
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn delete_room_message(
        &self,
        room_id: &str,
        msg_seq: u64,
    ) -> Result<Option<RoomMessage>, ChatStoreError> {
        let existing = self.get_room_message(room_id, msg_seq)?;
        if existing.is_some() {
            let conn = self.conn.lock().expect("store mutex poisoned");
            conn.execute(
                "DELETE FROM room_messages WHERE room_id = ?1 AND msg_seq = ?2",
                params![room_id, msg_seq as i64],
            )?;
        }
        Ok(existing)
    }
}

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}
