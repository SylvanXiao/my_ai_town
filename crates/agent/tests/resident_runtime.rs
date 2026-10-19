use crate::support::*;
use agent::{
    budget::Limits,
    context,
    runtime::ResidentRuntime,
    session::{GoalStatus, PauseKind},
};
use serde_json::json;

#[test]
fn outdated_replies_are_counted_and_two_revision_conflicts_in_a_row_stop_only_this_resident() {
    let mut w = world();
    let mut r = runtime(&mut w, Limits::default());
    let counts = |r: &ResidentRuntime| {
        let s = r.session("r1").unwrap();
        (
            s.tally.replies,
            s.tally.stale_replies,
            s.streaks.stale_streak,
        )
    };
    let first = request(&mut r, &mut w);
    // 请求期间外部改了安排：整条回复作废。
    w.interrupt_actions("r1", "安排被打断");
    assert!(!reply_with(&mut r, &mut w, &first, "先看看。", vec![]));
    assert_eq!(counts(&r), (1, 1, 1));
    assert!(r.session("r1").unwrap().pause_reason().is_none());
    // 请求期间收到重要通知：改变世界的动作被退回，但这和速度无关，不计连续次数。
    let second = request(&mut r, &mut w);
    w.set_need_values("r1", Some(30.0), None).unwrap();
    reply(
        &mut r,
        &mut w,
        &second,
        "run_actions",
        json!({"actions":[{"intent":{"verb":"阅读公告"},"prop_id":"board"}]}),
    );
    assert_eq!(counts(&r), (2, 2, 1));
    assert!(r.session("r1").unwrap().pause_reason().is_none());
    // 又一次请求期间世界状态被改掉：连续两次，停本人。
    let third = request(&mut r, &mut w);
    w.interrupt_actions("r1", "安排又被打断");
    assert!(!reply_with(&mut r, &mut w, &third, "再看看。", vec![]));
    assert_eq!(counts(&r), (3, 3, 2));
    let s = r.session("r1").unwrap();
    assert_eq!(s.pause_kind(), PauseKind::Stale);
    assert!(s.pause_reason().is_some());
    // 停下的人不再做决定，世界照走会把他饿死渴死：全镇一起停
    assert_eq!(r.town_holds(&w).len(), 1, "过时也让全镇暂停");
    w.step(30.0);
    assert!(r.poll(&mut w, true).is_empty());
    assert_eq!(r.resume(&w), 1);
    let fourth = request(&mut r, &mut w);
    reply(&mut r, &mut w, &fourth, "observe", json!({}));
    assert_eq!(counts(&r), (4, 3, 0));
    let view = r.view(&w, "r1").unwrap();
    assert_eq!((view.replies, view.stale_replies), (4, 3));
}

#[test]
fn repeated_model_failures_pause_the_town_after_bounded_retries() {
    let mut w = world();
    let mut r = runtime(&mut w, Limits::default());
    for attempt in 1..=3 {
        let q = request(&mut r, &mut w);
        assert!(r.on_reply(
            &mut w,
            "r1",
            q.stamp.id,
            q.stamp.epoch,
            Err(agent::completion::ModelError::Http {
                status: 504,
                detail: "网关超时".into()
            }),
            90_000
        ));
        let s = r.session("r1").unwrap();
        assert_eq!(s.streaks.model_failures, attempt);
        if attempt < 3 {
            assert!(s.pause_reason().is_none(), "前两次按 30 分钟搁置重试");
            assert!(s.sleep().is_some());
            w.step(31.0);
        }
    }
    let s = r.session("r1").unwrap();
    assert_eq!(s.pause_kind(), PauseKind::Fault);
    assert!(s.pause_reason().unwrap().contains("连续 3 次"));
    let holds = r.town_holds(&w);
    assert_eq!(holds.len(), 1);
    // 提示卡按原因类别给修复按钮：服务端出错是「拒收」，不是密钥或网络
    assert_eq!(holds[0].cause, protocol::HoldCause::Rejected);
    w.step(31.0);
    assert!(r.poll(&mut w, true).is_empty());
    assert_eq!(r.resume(&w), 1);
    assert_eq!(r.session("r1").unwrap().streaks.model_failures, 0);
    assert_eq!(r.poll(&mut w, true).len(), 1);
}

#[test]
fn pending_action_and_goal_survive_compaction_and_process_recovery() {
    let mut w = world();
    let mut r = runtime(&mut w, Limits::default());
    let goal = request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &goal,
        "set_goal",
        json!({"id":"read","title":"看公告","condition":{"kind":"action","verb":"阅读公告","locale":"loc_a"},"status":"active","commitment":"读完再决定要不要接活"}),
    );
    let mut session = r.session("r1").unwrap().clone();
    assert!(context::compact(&mut session, 0).unwrap());
    assert_eq!(session.goals["read"].commitment, "读完再决定要不要接活");
    let q = request(&mut r, &mut w);
    reply(
        &mut r,
        &mut w,
        &q,
        "run_actions",
        json!({"actions":[{"intent":{"verb":"阅读公告"},"prop_id":"board"}]}),
    );
    w.step(0.3);
    let mut pending = r.session("r1").unwrap().clone();
    let before = pending.messages.clone();
    assert!(context::compact(&mut pending, 0).is_err());
    assert_eq!(pending.messages, before);
    let saved_world = serde_json::to_value(w.snapshot()).unwrap();
    let saved_runtime = serde_json::to_value(r.state()).unwrap();
    let mut recovered = world();
    recovered
        .restore_snapshot(serde_json::from_value(saved_world).unwrap())
        .unwrap();
    let mut restored =
        ResidentRuntime::restore(serde_json::from_value(saved_runtime).unwrap(), &recovered)
            .unwrap();
    recovered.step(0.8);
    let q = request(&mut restored, &mut recovered);
    reply(
        &mut restored,
        &mut recovered,
        &q,
        "set_goal",
        json!({"id":"read","title":"看公告","condition":{"kind":"action","verb":"阅读公告","locale":"loc_a"},"status":"completed","commitment":"读完再决定要不要接活"}),
    );
    assert_eq!(
        restored.session("r1").unwrap().goals["read"].status,
        GoalStatus::Completed
    );
    assert_eq!(recovered.actor("r1").unwrap().actions.groups.len(), 1);
}

#[test]
fn bounded_concurrency_dispatches_other_residents_fairly() {
    let mut w = world();
    w.spawn("r2", "阿禾", "loc_a").unwrap();
    w.spawn("r3", "阿林", "loc_a").unwrap();
    let mut r = runtime(
        &mut w,
        Limits {
            max_concurrent: 2,
            ..Limits::default()
        },
    );
    r.register(&mut w, "r2", "喜欢看书").unwrap();
    r.register(&mut w, "r3", "喜欢手工").unwrap();
    let initial = r.poll(&mut w, true);
    assert_eq!(initial.len(), 2);
    assert!(r.poll(&mut w, true).is_empty());
    reply(&mut r, &mut w, &initial[0], "observe", json!({}));
    let next = r.poll(&mut w, true);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].actor_id, "r3");
    assert!(r.poll(&mut w, false).is_empty());
}
