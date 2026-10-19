//! 村民模型请求的并发池：建在 tasks::TaskPool 上，结果经通道交回主循环。
//! 任务携带发出时的模型配置，工作线程不读取或修改世界。
use crate::llm::{post_completion, LlmTarget};
use crate::tasks::TaskPool;
use agent::{
    completion::{self, ModelError},
    conversation::{ModelReply, Role},
    runtime::{AgentRequest, RuntimeState},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::mpsc::{sync_channel, Receiver, SyncSender},
    time::{Duration, Instant},
};

/// 旧存档还带着已删掉的工具协议字段（`protocol`），读入时忽略。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSave {
    pub runtime: RuntimeState,
}

pub struct Work {
    pub request: AgentRequest,
    pub target: LlmTarget,
}
pub struct WorkResult {
    pub actor: String,
    pub id: u64,
    pub epoch: u64,
    pub reply: Result<ModelReply, ModelError>,
    pub latency_ms: u64,
}
/// 最多 `concurrency` 个请求同时在途、`concurrency` 个排队；满了由调用方按未发出处理。
pub struct WorkerPool {
    tasks: TaskPool,
    finished: SyncSender<WorkResult>,
    pub results: Receiver<WorkResult>,
    /// 固定回复模式：等这么久后回一条固定回复，不连模型。
    mock_delay: Option<Duration>,
}

impl WorkerPool {
    pub fn new(concurrency: usize, mock_delay: Option<Duration>) -> Self {
        assert!((1..=16).contains(&concurrency));
        let (finished, results) = sync_channel(concurrency * 2);
        Self {
            tasks: TaskPool::new(concurrency, concurrency),
            finished,
            results,
            mock_delay,
        }
    }

    /// 排进队列；队列满或线程不可用时返回错误，请求没有发出。
    pub fn submit(&self, work: Work) -> Result<(), ModelError> {
        let finished = self.finished.clone();
        let mock_delay = self.mock_delay;
        self.tasks
            .submit(move || {
                let start = Instant::now();
                let reply = match mock_delay {
                    Some(delay) => {
                        std::thread::sleep(delay);
                        Ok(mock_reply(&work.request))
                    }
                    None => complete(&work.target, &work.request),
                };
                // 主循环已经退出时没有人收结果，丢掉即可。
                let _ = finished.send(WorkResult {
                    actor: work.request.actor_id,
                    id: work.request.stamp.id,
                    epoch: work.request.stamp.epoch,
                    reply,
                    latency_ms: start.elapsed().as_millis() as u64,
                });
            })
            .map_err(|_| ModelError::NotSent("模型队列已满或工作线程不可用".into()))
    }
}

/// 发一次村民请求：正文与解析在 agent::completion，这里只走 HTTP。
pub fn complete(target: &LlmTarget, request: &AgentRequest) -> Result<ModelReply, ModelError> {
    let body = completion::tool_request_body(request, &target.model);
    completion::parse_tool_reply(&post_completion(target, &body)?)
}

/// 仅用于离线接线验收：看一次眼前道具，然后等待；不作为真实模型行为证据。
fn mock_reply(request: &AgentRequest) -> ModelReply {
    if let Some(task) = request
        .messages
        .iter()
        .filter_map(|m| serde_json::from_str::<Value>(&m.content).ok())
        .find(|v| v.get("reflection_task").is_some())
    {
        return ModelReply {
            thought: "离线整理接线检查。".into(),
            calls: vec![agent::conversation::ToolCall {
                id: format!("mock_reflect_{}", request.stamp.id),
                name: "reflect".into(),
                arguments: json!({
                    "through_event": task["reflection_task"]["through"],
                    "summary": "离线工具接线验证，不作为真实模型总结效果证据。",
                    "notes": [],
                }),
            }],
            usage: None,
        };
    }
    let observation = request
        .messages
        .iter()
        .rev()
        .find_map(|m| {
            serde_json::from_str::<Value>(&m.content)
                .ok()
                .filter(|v| v.get("observation").is_some())
        })
        .unwrap_or_default();
    let props = observation["observation"]["visible_props"].as_array();
    let (name, arguments) = if request.messages.iter().any(|m| m.role == Role::Tool) {
        (
            "wait_for",
            json!({"minutes":30,"reason":"离线接线检查已完成，等待下一次观察"}),
        )
    } else if let Some(prop) = props.and_then(|p| p.first()) {
        ("inspect", json!({"id":prop["id"]}))
    } else {
        ("observe", json!({}))
    };
    ModelReply {
        thought: "先了解身边的情况。".into(),
        calls: vec![agent::conversation::ToolCall {
            id: format!("mock_{}", request.stamp.id),
            name: name.into(),
            arguments,
        }],
        usage: None,
    }
}
