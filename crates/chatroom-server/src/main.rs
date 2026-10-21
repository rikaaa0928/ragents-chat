use clap::Parser;
use chatroom_server::{
    serve_chat_tcp, ChatServerState, ChatroomStore, RoomCoordinator, UpdateManagerSettingsRequest,
};
use ragents_client::RagentsClient;
use ragents_protocol::ExtensionSpec;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Parser)]
#[command(name = "ragents-chat", about = "Multi-Agent AI Chatroom Server & Web UI powered by ragents")]
struct Cli {
    /// Listen address for the Chatroom HTTP & Web UI server
    #[arg(long, default_value = "127.0.0.1:8090")]
    listen: String,

    /// Public or internal base URL where `chatroom.wasm` can reach this server's `/api/v1/internal/agent-speak`
    #[arg(long)]
    callback_url: Option<String>,

    /// SQLite database file path for chatroom state
    #[arg(long, default_value = ".ragents-chat/chatroom.sqlite")]
    db: PathBuf,

    /// Access token required for Browser/API access to `ragents-chat`
    #[arg(long, env = "RAGENTS_CHAT_AUTH_TOKEN")]
    auth_token: Option<String>,

    /// Upstream `ragents-apiserver` URL
    #[arg(long, env = "RAGENTS_SERVER_URL", default_value = "http://127.0.0.1:8080")]
    ragents_url: String,

    /// Auth token for upstream `ragents-apiserver`
    #[arg(long, env = "RAGENTS_AUTH_TOKEN")]
    ragents_token: Option<String>,

    /// Default LLM model for Manager and newly created Agents
    #[arg(long, env = "RAGENTS_MODEL")]
    default_model: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if let Some(parent) = cli.db.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let default_model = cli
        .default_model
        .unwrap_or_else(|| "gpt-4.1-mini".to_string());

    let default_extensions = vec![
        ExtensionSpec {
            name: "agents_md".to_string(),
            path: String::new(),
            enabled: true,
            config: serde_json::json!({}),
            allowed_dirs: vec![],
        },
        ExtensionSpec {
            name: "skills".to_string(),
            path: String::new(),
            enabled: true,
            config: serde_json::json!({}),
            allowed_dirs: vec![],
        },
        ExtensionSpec {
            name: "shell".to_string(),
            path: String::new(),
            enabled: true,
            config: serde_json::json!({}),
            allowed_dirs: vec![],
        },
        ExtensionSpec {
            name: "file_editor".to_string(),
            path: String::new(),
            enabled: true,
            config: serde_json::json!({}),
            allowed_dirs: vec![],
        },
        ExtensionSpec {
            name: "image_viewer".to_string(),
            path: String::new(),
            enabled: true,
            config: serde_json::json!({}),
            allowed_dirs: vec![],
        },
        ExtensionSpec {
            name: "compaction".to_string(),
            path: String::new(),
            enabled: true,
            config: serde_json::json!({
                "enabled": true,
                "trigger_tokens": 400000,
                "keep_recent_tokens": 64000
            }),
            allowed_dirs: vec![],
        },
    ];

    let store = ChatroomStore::open(&cli.db, &default_model, default_extensions.clone())?;
    store.update_manager_settings(UpdateManagerSettingsRequest {
        manager_model: Some(default_model.clone()),
        manager_system_prompt: None,
        default_agent_model: Some(default_model),
        default_reasoning_effort: None,
        default_reasoning_summary: None,
        default_web_search: None,
        default_extensions: Some(default_extensions),
        default_node_id: None,
        default_workspace_root: None,
        idle_peek_debounce_ms: None,
        max_agent_relay_depth: None,
    })?;

    let listener = TcpListener::bind(&cli.listen).await?;
    let local_addr = listener.local_addr()?;
    let callback_base_url = cli
        .callback_url
        .unwrap_or_else(|| format!("http://{local_addr}"));

    let ragents_client =
        RagentsClient::new(cli.ragents_url.clone()).with_auth_token(cli.ragents_token.clone());

    let coordinator = RoomCoordinator::new(store, ragents_client, callback_base_url.clone());

    let state = ChatServerState {
        coordinator,
        auth_token: cli.auth_token.map(Arc::new),
    };

    let cancel = CancellationToken::new();
    let bound = serve_chat_tcp(listener, state, cancel.clone()).await?;
    println!("ragents-chat listening on http://{bound} (upstream ragents: {})", cli.ragents_url);

    tokio::signal::ctrl_c().await?;
    cancel.cancel();
    Ok(())
}
