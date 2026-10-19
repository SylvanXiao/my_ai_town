use crate::support::*;
use agent::{
    budget::Limits,
    conversation::Role,
    memory::{EvidenceSource, MemoryIndex, RecallQuery},
    runtime::ResidentRuntime,
    session::GoalStatus,
};
use protocol::{InteractionCommand as Command, InteractionKind, InteractionStatus};
use serde_json::json;

fn command(w: &mut kernel::World, actor: &str, key: &str, cmd: Command) {
    w.interact(actor, key, w.actor(actor).unwrap().actions.revision, &cmd)
        .unwrap();
}

#[test]
fn chat_turns_restore_and_reject_other_partys_stale_reply() {
    busy_invitation_does_not_cancel_work_until_the_resident_accepts();
    invitation_reply_repairs_format_without_assuming_consent();
    let mut w = world();
    w.spawn("r2", "小禾", "loc_a").unwrap();
    let mut r = runtime(&mut w, Limits::default());
    r.register(&mut w, "r2", "我会独立决定是否参加交谈。")
        .unwrap();
    let requests = r.poll(&mut w, true);
    let first = requests.iter().find(|q| q.actor_id == "r1").unwrap();
    let old_partner = requests.iter().find(|q| q.actor_id == "r2").unwrap();
    reply(
        &mut r,
        &mut w,
        first,
        "offer_invitation",
        json!({"partner_id":"r2","interaction":{"kind":"talk"},"message":"听说图书馆明天关闭"}),
    );
    let invitation = w.interactions().for_actor("r1")[0].id.clone();
    // 邀请在对方请求途中送达，旧请求须先 observe；不能拿旧观察直接同意。
    reply(
        &mut r,
        &mut w,
        old_partner,
        "reply_invitation",
        json!({"interaction_id":invitation,"accept":true,"message":"好"}),
    );
    assert_eq!(
        w.interactions().for_actor("r1")[0].status,
        InteractionStatus::Offered
    );
    // 交谈邀请发出后邀请者本次醒来结束，只有受邀者请求模型。
    let requests = r.poll(&mut w, true);
    assert!(requests.iter().all(|q| q.actor_id == "r2"));
    let receiver = requests.iter().find(|q| q.actor_id == "r2").unwrap();
    reply(
        &mut r,
        &mut w,
        receiver,
        "reply_invitation",
        json!({"interaction_id":invitation,"accept":true,"message":"我愿意聊聊，不过我还没核实"}),
    );
    assert_eq!(
        w.interactions().for_actor("r1")[0].status,
        InteractionStatus::Running
    );
    // 超过原来的五分钟仍在聊天；邀请状态随对方回应返回给邀请者，只有轮到的人请求模型。
    w.step(6.0);
    let q = request(&mut r, &mut w);
    assert_eq!(q.actor_id, "r1");
    let session = r.session("r1").unwrap();
    let offer_result = session
        .messages
        .iter()
        .rev()
        .find(|m| m.role == Role::Tool)
        .unwrap();
    assert!(offer_result.content.contains("\"replied\":true"));
    reply(
        &mut r,
        &mut w,
        &q,
        "interact",
        json!({"operation":"say","interaction_id":invitation,"message":"那我们明天去核实一下。","to":"r2"}),
    );
    let mut fresh = world();
    fresh.spawn("r2", "小禾", "loc_a").unwrap();
    fresh.restore_snapshot(w.snapshot()).unwrap();
    w = fresh;
    r = ResidentRuntime::restore(r.state().clone(), &w).unwrap();
    let next = request(&mut r, &mut w);
    assert_eq!(next.actor_id, "r2");
    reply(
        &mut r,
        &mut w,
        &next,
        "interact",
        json!({"operation":"leave","interaction_id":invitation,"message":"好，我先去吃饭。"}),
    );
    let requests = r.poll(&mut w, true);
    assert_eq!(requests.len(), 2);
    let s = r.session("r2").unwrap();
    let call = format!("c{}", receiver.stamp.id);
    assert_eq!(
        s.messages
            .iter()
            .filter(|m| m.role == Role::Tool && m.call_id.as_ref() == Some(&call))
            .count(),
        1
    );
    assert!(s.pending.is_empty());
    let reported = s
        .memory
        .records
        .iter()
        .find(|m| m.text.contains("图书馆明天关闭"))
        .unwrap();
    assert_eq!(reported.source, EvidenceSource::Reported);
    assert_eq!(reported.confidence, 0.5);
    let mut index = MemoryIndex::new().unwrap();
    let recalled = index
        .recall(
            "r2",
            &s.memory,
            &RecallQuery {
                object: Some("r1".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(recalled
        .iter()
        .any(|m| m.source == EvidenceSource::Reported));
    assert!(index
        .recall("r3", &s.memory, &RecallQuery::default())
        .is_err());
    let mut q = requests
        .iter()
        .find(|q| q.actor_id == "r2")
        .unwrap()
        .clone();
    if let Some(through) = q.messages.iter().find_map(|m| {
        serde_json::from_str::<serde_json::Value>(&m.content)
            .ok()
            .and_then(|v| v["reflection_task"]["through"].as_u64())
    }) {
        reply(
            &mut r,
            &mut w,
            &q,
            "reflect",
            json!({"through_event":through,"summary":"与阿树交谈，消息仍需核实。","notes":[]}),
        );
        q = r
            .poll(&mut w, true)
            .into_iter()
            .find(|q| q.actor_id == "r2")
            .unwrap();
    }
    reply(
        &mut r,
        &mut w,
        &q,
        "set_goal",
        json!({"id":"talked","title":"与阿树聊聊","condition":{"kind":"interaction","interaction_id":invitation},"status":"completed"}),
    );
    assert_eq!(
        r.session("r2").unwrap().goals["talked"].status,
        GoalStatus::Completed
    );
    ResidentRuntime::restore(r.state().clone(), &w).unwrap();
}

fn busy_invitation_does_not_cancel_work_until_the_resident_accepts() {
    let mut w = world();
    let mut r = runtime(&mut w, Limits::default());
    w.spawn("r2", "打招呼的人", "loc_a").unwrap();
    w.enable_agent("r2").unwrap();
    let q = request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &q,
        "run_actions",
        json!({"actions":[
            {"intent":{"verb":"停留","duration_minutes":1000}},
            {"intent":{"verb":"停留","duration_minutes":10}}
        ]}),
    );
    w.step(1.);
    let group = w
        .actor("r1")
        .unwrap()
        .actions
        .groups
        .keys()
        .next()
        .unwrap()
        .clone();
    let original_call = r.session("r1").unwrap().pending[0].call().id.clone();
    let invite = |w: &mut kernel::World, id: &str| {
        command(
            w,
            "r2",
            id,
            Command::Offer {
                partner_id: "r1".into(),
                interaction: InteractionKind::Talk,
                message: "方便聊聊吗？".into(),
            },
        )
    };
    invite(&mut w, "busy-no");
    let q = request(&mut r, &mut w);
    assert_eq!(
        w.action_group("r1", &group).unwrap().status,
        protocol::GroupStatus::Running
    );
    assert!(agent::context::paired(&q.messages));
    ResidentRuntime::restore(r.state().clone(), &w).unwrap();
    reply(
        &mut r,
        &mut w,
        &q,
        "reply_invitation",
        json!({"interaction_id":"busy-no","accept":false,"message":"我还在忙，稍后吧"}),
    );
    assert!(r.poll(&mut w, true).is_empty());
    assert_eq!(
        w.action_group("r1", &group).unwrap().status,
        protocol::GroupStatus::Running
    );
    r = ResidentRuntime::restore(r.state().clone(), &w).unwrap();
    invite(&mut w, "busy-expire");
    let q = request(&mut r, &mut w);
    assert!(reply_with(&mut r, &mut w, &q, "暂时没有决定", vec![]));
    w.step(601.);
    assert!(r.poll(&mut w, true).is_empty());
    assert_eq!(
        w.interactions().of("r1", "busy-expire").unwrap().status,
        InteractionStatus::Expired
    );
    assert_eq!(
        w.action_group("r1", &group).unwrap().status,
        protocol::GroupStatus::Running
    );
    invite(&mut w, "busy-yes");
    let q = request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &q,
        "reply_invitation",
        json!({"interaction_id":"busy-yes","accept":true,"message":"这回可以，我先停下"}),
    );
    r.poll(&mut w, true);
    assert_eq!(w.active_chat("r1").unwrap().id, "busy-yes");
    let g = w.action_group("r1", &group).unwrap();
    assert_eq!(g.status, protocol::GroupStatus::Interrupted);
    assert_eq!(g.results.len(), 2);
    let s = r.session("r1").unwrap();
    assert!(s.pending.is_empty());
    assert_eq!(
        s.messages
            .iter()
            .filter(|m| m.role == Role::Tool && m.call_id.as_ref() == Some(&original_call))
            .count(),
        1
    );
    assert!(agent::context::paired(&s.messages));
    ResidentRuntime::restore(r.state().clone(), &w).unwrap();
}

fn invitation_reply_repairs_format_without_assuming_consent() {
    let mut w = world();
    w.spawn("r2", "邀请者", "loc_a").unwrap();
    w.enable_agent("r2").unwrap();
    let mut r = runtime(&mut w, Limits::default());
    command(
        &mut w,
        "r2",
        "repair-invite",
        Command::Offer {
            partner_id: "r1".into(),
            interaction: InteractionKind::Talk,
            message: "聊聊？".into(),
        },
    );
    let q = request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &q,
        "reply_invitation",
        json!({"partner_id":"r2","interaction":{"kind":"talk"},"message":"当然可以"}),
    );
    assert_eq!(
        w.interactions().of("r1", "repair-invite").unwrap().status,
        InteractionStatus::Offered
    );
    let q = request(&mut r, &mut w);
    // 格式错误退回时告诉模型可回应的邀请编号。
    assert!(q.messages.iter().any(|m| {
        serde_json::from_str::<serde_json::Value>(&m.content)
            .is_ok_and(|v| v["error_kind"] == "invalid_arguments")
            && m.content.contains("repair-invite")
    }));
    reply(
        &mut r,
        &mut w,
        &q,
        "reply_invitation",
        json!({"interaction_id":"repair-invite","message":"当然可以"}),
    );
    assert!(r.poll(&mut w, true).is_empty());
    assert_eq!(
        r.session("r1")
            .unwrap()
            .invitation_reply_failure
            .as_ref()
            .unwrap()
            .attempts,
        2
    );
    r = ResidentRuntime::restore(r.state().clone(), &w).unwrap();
    assert_eq!(
        r.session("r1")
            .unwrap()
            .invitation_reply_failure
            .as_ref()
            .unwrap()
            .attempts,
        2
    );
    w.step(31.0);
    let q = request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &q,
        "reply_invitation",
        json!({"interaction_id":"repair-invite","accept":false,"message":"现在不方便"}),
    );
    assert_eq!(
        w.interactions().of("r1", "repair-invite").unwrap().status,
        InteractionStatus::Declined
    );
    assert!(r.session("r1").unwrap().invitation_reply_failure.is_none());
}

/// 交谈轮次的兜底：一次回复没有调用就倾听；格式错误或模型掉线连续两次后代为倾听。
/// 都只交出发言权，不替村民说话，也不搁置，交谈照常轮到对方。
#[test]
fn chat_turn_fallbacks_yield_the_turn_without_speaking_for_the_resident() {
    let mut w = world();
    let mut r = runtime(&mut w, Limits::default());
    w.spawn("r2", "小禾", "loc_a").unwrap();
    w.enable_agent("r2").unwrap();
    let offer = Command::Offer {
        partner_id: "r2".into(),
        interaction: InteractionKind::Talk,
        message: "来聊聊".into(),
    };
    command(&mut w, "r1", "chat", offer);
    let accept = Command::Reply {
        interaction_id: "chat".into(),
        accept: true,
        message: "好".into(),
    };
    command(&mut w, "r2", "accept", accept);
    // 邀请与回应的话已是开场台词；之后本人不该再有任何台词。
    let opening = w
        .interactions()
        .of("r1", "chat")
        .unwrap()
        .chat
        .as_ref()
        .unwrap()
        .entries
        .len();
    let partner_speaks = |w: &mut kernel::World, text: &str| {
        assert!(w.chat_turn("r2"), "发言权应已交给对方");
        let say = Command::Say {
            interaction_id: "chat".into(),
            message: text.into(),
            to: None,
        };
        command(w, "r2", text, say);
        assert!(w.chat_turn("r1"));
    };
    let fail = |r: &mut ResidentRuntime, w: &mut kernel::World| {
        let q = request(r, w);
        assert_eq!(q.stamp.kind, protocol::RequestKind::Chat);
        r.on_reply(
            w,
            "r1",
            q.stamp.id,
            q.stamp.epoch,
            Err(agent::completion::ModelError::Network("连接被拒绝".into())),
            5,
        );
    };
    let bad_format = |r: &mut ResidentRuntime, w: &mut kernel::World| {
        let q = request(r, w);
        let call = tool_call("bad", "interact", json!({"operation":"say"}));
        assert!(reply_with(r, w, &q, "", vec![call]));
    };

    // 一次回复没有任何调用：当场倾听。
    let q = request(&mut r, &mut w);
    assert!(reply_with(&mut r, &mut w, &q, "先听听", vec![]));
    partner_speaks(&mut w, "你先说吧");
    // 格式错误：第一次留着发言权重试，第二次代为倾听。
    bad_format(&mut r, &mut w);
    assert!(w.chat_turn("r1"));
    bad_format(&mut r, &mut w);
    partner_speaks(&mut w, "那我接着说");
    // 模型掉线：同样重试一次，再失败就代为倾听，交谈不停。
    fail(&mut r, &mut w);
    assert!(w.chat_turn("r1"), "第一次失败后立即重试");
    fail(&mut r, &mut w);
    assert!(w.chat_turn("r2"));
    let s = r.session("r1").unwrap();
    assert!(s.pause_reason().is_none() && s.sleep().is_none());
    let chat = w.interactions().of("r1", "chat").unwrap();
    assert_eq!(chat.status, InteractionStatus::Running);
    let entries = &chat.chat.as_ref().unwrap().entries[opening..];
    assert!(
        !entries
            .iter()
            .any(|e| e.actor == "r1" && e.kind == protocol::ChatEntryKind::Speech),
        "兜底只交出发言权，不产生台词"
    );
}
