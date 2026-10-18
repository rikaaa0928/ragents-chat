use crate::coordinator::RoomCoordinator;
use crate::types::{ChatroomEvent, PostMessageRequest, RoomMessage, SenderKind};
use std::time::Duration;

/// Trigger `@Manager` via the room's real tool-driven `@Manager` Agent Session
/// (`chatroom_add_agent` / `chatroom_remove_agent` -> then `chatroom_speak`),
/// and wait for `@Manager` to post its public reply message in the chatroom.
pub async fn recruit_agents_via_manager(
    coord: &RoomCoordinator,
    room_id: &str,
    user_requirement: &str,
    _caller_agent_name: Option<&str>,
) -> anyhow::Result<RoomMessage> {
    let mut rx = coord.subscribe_room_events();
    let req_msg = coord
        .post_human_message(
            room_id,
            PostMessageRequest {
                sender_name: "Human".to_string(),
                content: user_requirement.to_string(),
                mentions: vec!["Manager".to_string()],
                visible_to: vec![],
                reply_to_seq: None,
            },
        )
        .await?;

    let min_seq = req_msg.msg_seq;
    let room_id_owned = room_id.to_string();

    let mgr_msg = tokio::time::timeout(Duration::from_secs(90), async move {
        while let Ok(ev) = rx.recv().await {
            if let ChatroomEvent::MessagePosted { room_id: r, message } = ev {
                if r == room_id_owned
                    && message.msg_seq > min_seq
                    && message.sender_kind == SenderKind::Manager
                {
                    return Ok(message);
                }
            }
        }
        Err(anyhow::anyhow!("Room event stream closed while waiting for @Manager"))
    })
    .await
    .map_err(|_| anyhow::anyhow!("@Manager timed out waiting for tool execution"))??;

    Ok(mgr_msg)
}
