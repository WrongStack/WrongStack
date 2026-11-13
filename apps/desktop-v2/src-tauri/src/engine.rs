//! Persistent native transport to WrongStack's backend. No frontend URL leaves
//! the host and no WebUI webview is created.
use crate::{err, now, Result};
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs::{File, OpenOptions},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{client, Message};

pub struct Engine {
    http: crate::http_bridge::EngineHttp,
    sender: SyncSender<Value>,
    pub connected: AtomicBool,
    identity: Mutex<Value>,
    /// The newest `browser.live.frame` and its sequence number. A screencast sends up to ten
    /// frames a second; they are kept in memory only, never in the event log on disk.
    live_frame: Mutex<(u64, Value)>,
    path: PathBuf,
}

/// Most complete journal lines one `events` page returns.
pub(crate) const PAGE_EVENTS: usize = 1000;
/// About how many journal bytes one `events` page reads (a longer last line still completes).
pub(crate) const PAGE_BYTES: u64 = 1024 * 1024;

/// Whether an engine message is a live browser frame that bypasses the event log.
pub(crate) fn is_live_frame(message: &Value) -> bool {
    message["type"] == "browser.live.frame"
}

/// How a snapshot broadcast the engine re-sends whole is journaled: at most one per `spacing`
/// (a newer one waits and replaces the waiting one, so the latest is always written), and an
/// unchanged one only after `refresh`. `None` for every other frame.
///
/// A project journal grew by ~35 MB an hour from these alone: the whole ~40 KB session
/// registry (`sessions.status_update`) after every tool call of every live agent, and one
/// supervisor status per Kanban board every five minutes (152 boards, unchanged apart from
/// their audit times). Every window replays the journal, so it opened slower each day. Only
/// the newest registry snapshot is ever read; five seconds keeps the office's 20 s heartbeat
/// freshness. An unchanged board needs no frame: a view that wants it now asks.
struct SnapshotPolicy {
    spacing: Duration,
    refresh: Duration,
}

fn snapshot_policy(kind: &str) -> Option<SnapshotPolicy> {
    let policy = |spacing: u64, refresh: u64| SnapshotPolicy {
        spacing: Duration::from_secs(spacing),
        refresh: Duration::from_secs(refresh),
    };
    match kind {
        "sessions.status_update" => Some(policy(5, 10)),
        "goal.list" => Some(policy(0, 60)),
        "kanban.supervisor.status" => Some(policy(0, 30 * 60)),
        _ => None,
    }
}

/// `value` without its time fields (`at`, `…At`, `timestamp`), so two snapshots that differ
/// only in when they were taken compare equal.
fn without_times(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| {
                    !(*key == "at"
                        || *key == "timestamp"
                        || *key == "requestId"
                        || key.ends_with("At"))
                })
                .map(|(key, item)| (key.clone(), without_times(item)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_times).collect()),
        other => other.clone(),
    }
}

/// The last journaled snapshot of one kind (and board): its fingerprint, when it was written,
/// and a newer one waiting for the spacing to pass.
struct SnapshotSlot {
    print: u64,
    written: Instant,
    spacing: Duration,
    waiting: Option<(u64, Value)>,
}

/// Keeps repeated snapshot broadcasts out of the journal. A reply to a request (it carries a
/// `requestId`) is always written at once: a view waits for it.
#[derive(Default)]
struct SnapshotGate {
    slots: HashMap<String, SnapshotSlot>,
    /// Requests sent for a gated kind whose answer has not arrived yet. Some answers are plain
    /// broadcasts without a `requestId` (`goal.list`); the one after a request is a reply a
    /// view waits for, so it is written even when it repeats the last one.
    asked: HashMap<String, u32>,
}

impl SnapshotGate {
    /// Notes an outgoing message, so the answer to a request for a gated kind gets through.
    fn sent(&mut self, message: &Value) {
        let kind = message["type"].as_str().unwrap_or_default();
        let requested = message["payload"]
            .get("requestId")
            .is_some_and(|v| !v.is_null());
        if !requested && snapshot_policy(kind).is_some() {
            *self.asked.entry(kind.to_string()).or_default() += 1;
        }
    }
    /// Whether `message` is written now. A snapshot that arrives inside its spacing waits,
    /// replacing any older one, until [`SnapshotGate::due`] hands it back.
    fn admit(&mut self, message: &Value, now: Instant) -> bool {
        let kind = message["type"].as_str().unwrap_or_default();
        let Some(policy) = snapshot_policy(kind) else {
            return true;
        };
        let payload = &message["payload"];
        let requested = payload.get("requestId").is_some_and(|v| !v.is_null());
        let answer = !requested
            && match self.asked.get_mut(kind) {
                Some(count) if *count > 0 => {
                    *count -= 1;
                    true
                }
                _ => false,
            };
        let key = match payload["data"]["boardId"]
            .as_str()
            .or_else(|| payload["boardId"].as_str())
        {
            Some(board) => format!("{kind}:{board}"),
            None => kind.to_string(),
        };
        let mut hasher = DefaultHasher::new();
        without_times(payload).to_string().hash(&mut hasher);
        let print = hasher.finish();
        if let Some(slot) = self.slots.get_mut(&key).filter(|_| !(requested || answer)) {
            let since = now.duration_since(slot.written);
            if slot.print == print && since < policy.refresh {
                // Back to what was written: an older waiting change is stale.
                slot.waiting = None;
                return false;
            }
            if since < policy.spacing {
                slot.waiting = Some((print, message.clone()));
                return false;
            }
        }
        self.slots.insert(
            key,
            SnapshotSlot {
                print,
                written: now,
                spacing: policy.spacing,
                waiting: None,
            },
        );
        true
    }
    /// Waiting snapshots whose spacing has passed (all of them when `all`), to write now.
    fn due(&mut self, now: Instant, all: bool) -> Vec<Value> {
        let mut ready = Vec::new();
        for slot in self.slots.values_mut() {
            if !all && now.duration_since(slot.written) < slot.spacing {
                continue;
            }
            if let Some((print, message)) = slot.waiting.take() {
                slot.print = print;
                slot.written = now;
                ready.push(message);
            }
        }
        ready
    }
}

/// Frames the engine sends once (at connect, or on a model change) whose state a reader needs
/// however far back they were written: who the session is, its model, whether it is connected.
const SEED_TYPES: [&str; 5] = [
    "session.start",
    "model.switch_result",
    "provider.fallback",
    "provider.primary_restored",
    "desktop.disconnected",
];

/// The file beside a journal holding the newest frame of each [`SEED_TYPES`] kind, in the
/// order they were written, so a reader that skips the journal's old part still starts from
/// them.
pub(crate) fn seed_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".seed.json");
    PathBuf::from(name)
}

/// The newest seed frames of one journal, oldest first.
struct JournalSeeds {
    path: PathBuf,
    frames: Vec<Value>,
}

impl JournalSeeds {
    fn load(journal: &Path) -> Self {
        let path = seed_path(journal);
        let frames = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
            .unwrap_or_default();
        Self { path, frames }
    }
    /// Keeps `message` when it is a seed kind; best effort, a failed write only means a later
    /// reader replays the whole journal.
    fn note(&mut self, message: &Value) {
        let kind = message["type"].as_str().unwrap_or_default();
        if !SEED_TYPES.contains(&kind) {
            return;
        }
        self.frames.retain(|frame| frame["type"] != kind);
        self.frames.push(message.clone());
        let next = self.path.with_extension("json.tmp");
        if serde_json::to_vec(&self.frames)
            .ok()
            .is_some_and(|bytes| std::fs::write(&next, bytes).is_ok())
        {
            let _ = std::fs::rename(&next, &self.path);
        }
    }
}

/// Records when the desktop received a frame, so the transcript can say when a message was
/// written. Per-token deltas and progress ticks stay unstamped: they are most of the journal,
/// and the frame before them already carries the time.
fn stamp_frame(message: &mut Value, at: i64) {
    let kind = message["type"].as_str().unwrap_or_default();
    if kind.ends_with("_delta") || kind.ends_with(".progress") || kind.ends_with("_progress") {
        return;
    }
    if let Some(frame) = message.as_object_mut() {
        frame.entry("at").or_insert(json!(at));
    }
}

/// Socket I/O that only means "not now": a read or write timeout, an interrupted call, or on
/// Windows an overlapped operation still in flight (ERROR_IO_PENDING, os error 997). The
/// engine connection is fine; treating 997 as fatal closed it at random, and the profile's
/// settings fell back to "Loading your WrongStack profile…" for the rest of the session.
fn transient_io(error: &std::io::Error) -> bool {
    const ERROR_IO_PENDING: i32 = 997;
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    ) || (cfg!(windows) && error.raw_os_error() == Some(ERROR_IO_PENDING))
}

/// A tungstenite result where a transient socket error is `Ok(false)` ("try again"): an
/// unsent frame stays in the socket's write buffer and the next flush delivers it.
fn settle<T>(result: tungstenite::Result<T>) -> Result<bool> {
    match result {
        Ok(_) => Ok(true),
        Err(tungstenite::Error::Io(e)) if transient_io(&e) => Ok(false),
        Err(e) => Err(err(e)),
    }
}

fn scope_message(message: &mut Value, identity: &Value, bind_session: bool) {
    if bind_session {
        if let Some(id) = identity["sessionId"].as_str() {
            if !message["payload"].is_object() {
                message["payload"] = json!({});
            }
            message["payload"]["sessionId"] = json!(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_live_frame, scope_message, seed_path, stamp_frame, transient_io, Engine, JournalSeeds,
        SnapshotGate,
    };
    use serde_json::json;
    use std::fs;
    use std::time::Duration;
    use uuid::Uuid;

    #[test]
    fn a_pending_or_timed_out_socket_operation_keeps_the_engine_connected() {
        use std::io::{Error, ErrorKind};
        assert!(transient_io(&Error::from(ErrorKind::WouldBlock)));
        assert!(transient_io(&Error::from(ErrorKind::TimedOut)));
        assert!(transient_io(&Error::from(ErrorKind::Interrupted)));
        assert_eq!(transient_io(&Error::from_raw_os_error(997)), cfg!(windows));
        assert!(!transient_io(&Error::from(ErrorKind::ConnectionReset)));
        assert!(!transient_io(&Error::from(ErrorKind::BrokenPipe)));
    }

    #[test]
    fn stamps_frames_with_their_arrival_but_not_token_deltas() {
        let mut result = json!({"type": "run.result", "payload": {"status": "done"}});
        stamp_frame(&mut result, 42);
        assert_eq!(result["at"], json!(42));
        let mut earlier = json!({"type": "run.result", "at": 7});
        stamp_frame(&mut earlier, 42);
        assert_eq!(earlier["at"], json!(7));
        for kind in [
            "provider.text_delta",
            "provider.thinking_delta",
            "tool.progress",
        ] {
            let mut delta = json!({"type": kind, "payload": {}});
            stamp_frame(&mut delta, 42);
            assert!(delta.get("at").is_none(), "{kind} was stamped");
        }
    }

    #[test]
    fn live_browser_frames_bypass_the_event_log() {
        assert!(is_live_frame(
            &json!({"type": "browser.live.frame", "payload": {"data": "x"}})
        ));
        assert!(!is_live_frame(
            &json!({"type": "browser.live.details", "payload": {}})
        ));
        assert!(!is_live_frame(
            &json!({"type": "session.start", "payload": {}})
        ));
    }

    #[test]
    fn project_requests_preserve_project_scope_and_session_requests_bind_identity() {
        let identity = json!({"sessionId":"internal-session"});
        let mut project = json!({"type":"chronicle.metrics","payload":{"view":"tasks"}});
        scope_message(&mut project, &identity, false);
        assert!(project["payload"].get("sessionId").is_none());
        let mut selected = json!({"type":"chronicle.metrics","payload":{"sessionId":"explicit"}});
        scope_message(&mut selected, &identity, false);
        assert_eq!(selected["payload"]["sessionId"], "explicit");
        let mut session = json!({"type":"user_message","payload":{"sessionId":"wrong"}});
        scope_message(&mut session, &identity, true);
        assert_eq!(session["payload"]["sessionId"], "internal-session");
    }

    #[test]
    fn journal_reports_more_at_both_event_and_byte_limits() {
        let path = std::env::temp_dir().join(format!("desktop-events-{}.jsonl", Uuid::new_v4()));
        let small = format!("{}\n", json!({"type":"control","payload":{}}));
        fs::write(&path, &small).unwrap();
        let control = Engine::events(&path, 0).unwrap();
        assert_eq!(control["events"].as_array().unwrap().len(), 1);
        assert_eq!(control["offset"].as_u64().unwrap(), small.len() as u64);

        let large = format!(
            "{}\n",
            json!({"type":"large","payload":{"text":"x".repeat(super::PAGE_BYTES as usize)}})
        );
        fs::write(&path, format!("{large}{small}")).unwrap();
        let first = Engine::events(&path, 0).unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(), 1);
        assert_eq!(
            first["hasMore"], true,
            "Byte-bounded pages must keep replay pending"
        );
        let tail = Engine::events(&path, first["offset"].as_u64().unwrap()).unwrap();
        assert_eq!(tail["events"][0]["type"], "control");
        assert_eq!(tail["hasMore"], false);

        fs::write(&path, small.repeat(super::PAGE_EVENTS + 1)).unwrap();
        let first = Engine::events(&path, 0).unwrap();
        assert_eq!(
            first["events"].as_array().unwrap().len(),
            super::PAGE_EVENTS
        );
        assert_eq!(first["hasMore"], true);
        let tail = Engine::events(&path, first["offset"].as_u64().unwrap()).unwrap();
        assert_eq!(tail["events"].as_array().unwrap().len(), 1);
        assert_eq!(tail["hasMore"], false);
        assert_eq!(
            tail["size"], tail["offset"],
            "The page reports the journal's length"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn snapshot_broadcasts_are_spaced_and_repeats_wait_for_their_refresh() {
        let start = std::time::Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        let mut filter = SnapshotGate::default();
        let status = |beat: &str, agents: u64| {
            json!({"type":"sessions.status_update","payload":{"sessions":[{
                "id":"s1","lastHeartbeatAt":beat,"agentCount":agents,
                "agents":[{"lastActivityAt":beat}]}]}})
        };
        assert!(
            filter.admit(&status("t1", 1), start),
            "the first snapshot is written"
        );
        assert!(
            !filter.admit(&status("t2", 1), at(1)),
            "a snapshot differing only in its times is a repeat"
        );
        assert!(filter.due(at(2), false).is_empty(), "a repeat never waits");
        assert!(
            !filter.admit(&status("t3", 2), at(2)),
            "a change inside the spacing waits"
        );
        assert!(
            !filter.admit(&status("t4", 3), at(3)),
            "and a newer change replaces it"
        );
        assert!(
            filter.due(at(4), false).is_empty(),
            "not before the spacing"
        );
        let written = filter.due(at(5), false);
        assert_eq!(written.len(), 1, "the latest waiting snapshot is written");
        assert_eq!(written[0]["payload"]["sessions"][0]["agentCount"], 3);
        assert!(filter.due(at(30), false).is_empty(), "only once");
        assert!(
            filter.admit(&status("t5", 4), at(16)),
            "a change after the spacing is written at once"
        );
        assert!(
            filter.admit(&status("t6", 4), at(27)),
            "an unchanged snapshot is refreshed after its interval"
        );
        assert!(!filter.admit(&status("t7", 5), at(28)));
        assert_eq!(
            filter.due(at(29), true).len(),
            1,
            "a disconnect writes what waits"
        );
        let board = |id: &str, audit: &str| {
            json!({"type":"kanban.supervisor.status","payload":{"data":{
                "boardId":id,"lastAuditAt":audit,"nextAuditAt":audit,"status":"healthy"}}})
        };
        assert!(filter.admit(&board("b1", "a"), start));
        assert!(
            filter.admit(&board("b2", "a"), start),
            "boards are keyed apart"
        );
        assert!(!filter.admit(&board("b1", "b"), at(300)));
        let reply = json!({"type":"kanban.supervisor.status",
            "payload":{"requestId":"r1","data":{"boardId":"b1","status":"healthy"}}});
        assert!(
            filter.admit(&reply, at(301)),
            "a reply to a request is always written"
        );
        let goals = json!({"type":"goal.list","payload":{"graphs":[]}});
        assert!(filter.admit(&goals, at(400)));
        assert!(
            !filter.admit(&goals, at(401)),
            "an unasked repeat is dropped"
        );
        filter.sent(&json!({"type":"goal.list","payload":{}}));
        assert!(
            filter.admit(&goals, at(402)),
            "the answer to a request is written even when it repeats"
        );
        assert!(!filter.admit(&goals, at(403)), "only that answer");
        let message = json!({"type":"assistant_text_delta","payload":{"text":"x"}});
        assert!(filter.admit(&message, start) && filter.admit(&message, start));
    }

    #[test]
    fn a_recent_reader_starts_at_the_first_line_inside_its_window() {
        let path = std::env::temp_dir().join(format!("desktop-recent-{}.jsonl", Uuid::new_v4()));
        assert_eq!(
            Engine::recent_start(&path, 10).unwrap(),
            0,
            "missing journal"
        );
        let line = "{\"type\":\"a\",\"payload\":{}}\n";
        let n = line.len() as u64;
        fs::write(&path, line.repeat(4)).unwrap();
        assert_eq!(
            Engine::recent_start(&path, 1000).unwrap(),
            0,
            "short journal"
        );
        assert_eq!(
            Engine::recent_start(&path, n).unwrap(),
            3 * n,
            "a line beginning exactly at the window's start is included"
        );
        assert_eq!(Engine::recent_start(&path, n + 5).unwrap(), 3 * n);
        assert_eq!(Engine::recent_start(&path, 2 * n).unwrap(), 2 * n);
        let start = Engine::recent_start(&path, n + 5).unwrap();
        let page = Engine::events(&path, start).unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 1);
        assert_eq!(page["hasMore"], false);
        fs::write(&path, "x".repeat(100)).unwrap();
        assert_eq!(
            Engine::recent_start(&path, 10).unwrap(),
            100,
            "no complete line in the window"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_recent_read_is_led_by_the_seed_frames_written_long_before() {
        let path = std::env::temp_dir().join(format!("desktop-seed-{}.jsonl", Uuid::new_v4()));
        let filler = "{\"type\":\"mailbox.event\",\"payload\":{}}\n".repeat(200);
        let start = json!({"type":"session.start","payload":{"sessionId":"s1"}});
        fs::write(&path, format!("{start}\n{filler}")).unwrap();
        let without = Engine::recent_events(&path, 100).unwrap();
        assert_eq!(
            without["events"][0]["type"], "session.start",
            "a journal without seeds is read from its start"
        );
        let mut seeds = JournalSeeds::load(&path);
        seeds.note(&json!({"type":"mailbox.event","payload":{}}));
        seeds.note(&start);
        seeds.note(&json!({"type":"model.switch_result","payload":{"model":"a"}}));
        seeds.note(&json!({"type":"model.switch_result","payload":{"model":"b"}}));
        let reloaded = JournalSeeds::load(&path);
        assert_eq!(reloaded.frames.len(), 2, "one frame per seed kind");
        let page = Engine::recent_events(&path, 100).unwrap();
        let events = page["events"].as_array().unwrap();
        assert_eq!(events[0]["payload"]["sessionId"], "s1");
        assert_eq!(events[1]["payload"]["model"], "b", "the newest of a kind");
        assert!(events.len() < 10, "only the window follows the seeds");
        assert_eq!(events[2]["type"], "mailbox.event");
        fs::remove_file(seed_path(&path)).unwrap();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_tail_reader_starts_after_the_last_complete_line() {
        let path = std::env::temp_dir().join(format!("desktop-tail-{}.jsonl", Uuid::new_v4()));
        assert_eq!(Engine::journal_end(&path).unwrap()["offset"], 0);
        let line = format!("{}\n", json!({"type":"old","payload":{}}));
        fs::write(&path, format!("{line}{line}{{\"type\":\"par")).unwrap();
        let end = Engine::journal_end(&path).unwrap()["offset"]
            .as_u64()
            .unwrap();
        assert_eq!(
            end,
            (line.len() * 2) as u64,
            "A half-written line is not skipped"
        );
        fs::write(
            &path,
            format!("{line}{line}{}\n", json!({"type":"new","payload":{}})),
        )
        .unwrap();
        let next = Engine::events(&path, end).unwrap();
        assert_eq!(next["events"].as_array().unwrap().len(), 1);
        assert_eq!(next["events"][0]["type"], "new");

        let large_partial = format!("{{\"type\":\"large\",\"payload\":\"{}", "x".repeat(70_000));
        fs::write(&path, format!("{line}{large_partial}")).unwrap();
        let large_end = Engine::journal_end(&path).unwrap()["offset"]
            .as_u64()
            .unwrap();
        assert_eq!(
            large_end,
            line.len() as u64,
            "A half-written line exceeding 64 KiB must still rewind to the previous newline"
        );
        fs::write(&path, format!("{line}{large_partial}\"}}\n")).unwrap();
        let replayed = Engine::events(&path, large_end).unwrap();
        assert_eq!(replayed["events"].as_array().unwrap().len(), 1);
        assert_eq!(replayed["events"][0]["type"], "large");
        fs::remove_file(path).unwrap();
    }
}
impl Engine {
    pub fn connect(port: u16, token: &str, path: &Path, bind_session: bool) -> Result<Arc<Self>> {
        let stream = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().map_err(err)?,
            Duration::from_millis(400),
        )
        .map_err(err)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(err)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(err)?;
        let (mut socket, _) =
            client(format!("ws://127.0.0.1:{port}/?token={token}"), stream).map_err(err)?;
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(20)))
            .map_err(err)?;
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(err)?;
        let (sender, receiver) = sync_channel::<Value>(128);
        let engine = Arc::new(Self {
            http: crate::http_bridge::EngineHttp::new(port, token)?,
            sender,
            connected: AtomicBool::new(true),
            identity: Mutex::new(json!({})),
            live_frame: Mutex::new((0, Value::Null)),
            path: path.into(),
        });
        let owner = Arc::clone(&engine);
        let mut seeds = JournalSeeds::load(path);
        thread::spawn(move || {
            // One write per frame: `to_writer` on a bare `File` makes a system call per JSON
            // token, and a busy engine sends many frames tens of kilobytes long.
            let record = |log: &mut File, message: &Value| -> std::io::Result<()> {
                let mut line = serde_json::to_vec(message)?;
                line.push(b'\n');
                log.write_all(&line)
            };
            let mut snapshots = SnapshotGate::default();
            let result = (|| -> Result<()> {
                let mut unflushed = false;
                loop {
                    if unflushed {
                        unflushed = !settle(socket.flush())?;
                    }
                    // The read below waits at most 20 ms, so a waiting snapshot is written
                    // promptly once its spacing has passed.
                    for message in snapshots.due(Instant::now(), false) {
                        record(&mut log, &message).map_err(err)?;
                    }
                    while let Ok(mut message) = receiver.try_recv() {
                        let identity = owner.identity.lock().map_err(err)?;
                        scope_message(&mut message, &identity, bind_session);
                        drop(identity);
                        if !settle(socket.send(Message::Text(message.to_string().into())))? {
                            unflushed = true;
                        }
                        snapshots.sent(&message);
                        if message["type"] == "user_message" {
                            record(&mut log,&json!({"type":"desktop.user_message","payload":message["payload"],"at":now()})).map_err(err)?;
                        }
                    }
                    match socket.read() {
                        Ok(Message::Text(text)) => {
                            let mut message: Value = serde_json::from_str(&text).map_err(err)?;
                            if is_live_frame(&message) {
                                let mut frame = owner.live_frame.lock().map_err(err)?;
                                *frame = (frame.0 + 1, message["payload"].clone());
                                continue;
                            }
                            if message["type"] == "session.start" {
                                let mut identity = owner.identity.lock().map_err(err)?;
                                *identity = message["payload"].clone();
                            }
                            // Stamped on arrival, so a snapshot that waits keeps its own time.
                            stamp_frame(&mut message, now());
                            if snapshots.admit(&message, Instant::now()) {
                                record(&mut log, &message).map_err(err)?;
                                seeds.note(&message);
                            }
                        }
                        Ok(Message::Ping(_)) => {
                            unflushed = !settle(socket.flush())?;
                        }
                        Ok(Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e)) if transient_io(&e) => {}
                        Err(e) => return Err(err(e)),
                    }
                }
                Ok(())
            })();
            owner.connected.store(false, Ordering::Release);
            for message in snapshots.due(Instant::now(), true) {
                let _ = record(&mut log, &message);
            }
            let disconnected = json!({"type":"desktop.disconnected","payload":{"message":result.err().unwrap_or_else(||"Engine connection closed".into())}});
            let _ = record(&mut log, &disconnected);
            seeds.note(&disconnected);
        });
        Ok(engine)
    }
    pub fn send(&self, message: Value) -> Result<Value> {
        if !self.connected.load(Ordering::Acquire) {
            return Err("Engine is disconnected".into());
        }
        let kind = message["type"]
            .as_str()
            .ok_or("Missing engine message type")?;
        if matches!(
            kind,
            "session.new"
                | "session.resume"
                | "session.delete"
                | "projects.add"
                | "projects.select"
                | "working_dir.set"
        ) {
            return Err("Desktop owns project, workdir, and session lifecycle".into());
        }
        self.sender.try_send(message).map_err(err)?;
        Ok(Value::Null)
    }
    /// The newest live browser frame when it is newer than `after`, else null.
    pub fn live_frame(&self, after: u64) -> Value {
        self.live_frame
            .lock()
            .map(|frame| {
                if frame.0 > after && !frame.1.is_null() {
                    json!({"seq": frame.0, "frame": frame.1})
                } else {
                    Value::Null
                }
            })
            .unwrap_or(Value::Null)
    }
    pub fn identity(&self) -> Value {
        self.identity
            .lock()
            .map(|v| v.clone())
            .unwrap_or(Value::Null)
    }
    pub fn http(
        &self,
        method: &str,
        resource: &str,
        body: &Value,
        operation_id: Option<&str>,
    ) -> Result<Value> {
        let identity = self.identity();
        let session = identity["sessionId"]
            .as_str()
            .ok_or("Engine session is still starting")?;
        self.http
            .request(method, resource, body, session, operation_id)
    }
    /// The journal position after its last complete line, for a reader that follows only what
    /// is written from now on instead of replaying the journal from its start.
    pub fn journal_end(path: &Path) -> Result<Value> {
        let mut file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({"offset":0,"events":[],"hasMore":false,"tail":true}))
            }
            Err(e) => return Err(err(e)),
        };
        let mut cursor = file.metadata().map_err(err)?.len();
        let mut end = 0;
        let mut tail = Vec::new();
        while cursor > 0 {
            let start = cursor.saturating_sub(65536);
            file.seek(SeekFrom::Start(start)).map_err(err)?;
            tail.clear();
            (&mut file)
                .take(cursor - start)
                .read_to_end(&mut tail)
                .map_err(err)?;
            // A line still being written is left for the next read.
            if let Some(at) = tail.iter().rposition(|byte| *byte == b'\n') {
                end = start + at as u64 + 1;
                break;
            }
            cursor = start;
        }
        Ok(json!({"offset":end,"events":[],"hasMore":false,"tail":true}))
    }
    /// Reads at most [`PAGE_EVENTS`] complete lines or about [`PAGE_BYTES`] from `offset`.
    /// Every page is a round trip through the session host and a renderer update, so small
    /// pages made a long journal slow to reopen; a page stays far below the response frame.
    pub fn events(path: &Path, offset: u64) -> Result<Value> {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({"offset":offset,"events":[],"hasMore":false}))
            }
            Err(e) => return Err(err(e)),
        };
        // The journal's length, so a reader replaying it can show how far it got.
        let size = file.metadata().map_or(0, |meta| meta.len());
        let mut reader = BufReader::new(file);
        reader.seek(SeekFrom::Start(offset)).map_err(err)?;
        let mut events = Vec::new();
        let mut cursor = offset;
        let mut line = Vec::new();
        for _ in 0..PAGE_EVENTS {
            line.clear();
            let read = reader.read_until(b'\n', &mut line).map_err(err)?;
            if read == 0 || line.last() != Some(&b'\n') {
                break;
            }
            cursor += read as u64;
            events.push(serde_json::from_slice::<Value>(&line).map_err(err)?);
            if cursor - offset >= PAGE_BYTES {
                break;
            }
        }
        let has_more = events.len() == PAGE_EVENTS || cursor - offset >= PAGE_BYTES;
        Ok(json!({"offset":cursor,"events":events,"hasMore":has_more,"size":size}))
    }
    /// Where a reader that wants only about the last `window` bytes of a journal starts: the
    /// first line that begins at or after `size - window` (0 for a shorter journal).
    ///
    /// Project and profile journals are not a conversation: they hold replies and broadcast
    /// snapshots, and only the newest of each matters. Replaying hundreds of megabytes of them
    /// page by page through the session host made a project take minutes to open.
    pub fn recent_start(path: &Path, window: u64) -> Result<u64> {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(err(e)),
        };
        let size = file.metadata().map_err(err)?.len();
        if size <= window {
            return Ok(0);
        }
        // Read from the byte before the window: a line that begins exactly at its start is
        // found by the newline that ends the previous one.
        let from = size - window - 1;
        let mut reader = BufReader::new(file);
        reader.seek(SeekFrom::Start(from)).map_err(err)?;
        let mut skipped = Vec::new();
        let read = reader.read_until(b'\n', &mut skipped).map_err(err)?;
        if skipped.last() != Some(&b'\n') {
            // No complete line starts in the window: follow from the end.
            return Ok(size);
        }
        Ok(from + read as u64)
    }
    /// A first read of only about the last `window` bytes, led by the journal's seed frames
    /// (who the session is, its model, whether it is connected), which were written once and
    /// usually long before. A journal without a seed file, written by an older host, is read
    /// from its start as before.
    pub fn recent_events(path: &Path, window: u64) -> Result<Value> {
        let seeds = std::fs::read(seed_path(path))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok());
        let Some(seeds) = seeds else {
            return Self::events(path, 0);
        };
        let start = Self::recent_start(path, window)?;
        let mut page = Self::events(path, start)?;
        if start > 0 {
            if let Some(events) = page["events"].as_array_mut() {
                events.splice(0..0, seeds);
            }
        }
        Ok(page)
    }
    pub fn event_path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    use std::fs::OpenOptions;

    #[test]
    fn snapshot_gate_request_id_replies_update_slot_and_do_not_leak_asked() {
        let mut gate = SnapshotGate::default();
        let t0 = Instant::now();

        assert!(gate.admit(
            &json!({"type":"sessions.status_update","payload":{"sessions":[{"id":"s1","agentCount":1}]}}),
            t0
        ));
        assert!(!gate.admit(
            &json!({"type":"sessions.status_update","payload":{"sessions":[{"id":"s1","agentCount":2}]}}),
            t0 + Duration::from_secs(1)
        ));
        // Direct reply inside spacing must write immediately AND clear older waiting snapshot.
        assert!(gate.admit(
            &json!({"type":"sessions.status_update","payload":{"requestId":"r-1","sessions":[{"id":"s1","agentCount":3}]}}),
            t0 + Duration::from_secs(2)
        ));
        assert!(gate.due(t0 + Duration::from_secs(10), true).is_empty());

        // Outgoing request carrying `requestId` must not leak an `asked` ticket, and the
        // `requestId` reply must update `slot.print` so recovery back to healthy is admitted.
        assert!(gate.admit(
            &json!({"type":"kanban.supervisor.status","payload":{"data":{"boardId":"b1","status":"healthy"}}}),
            t0
        ));
        gate.sent(&json!({"type":"kanban.supervisor.status","payload":{"requestId":"r-sup"}}));
        assert!(gate.admit(
            &json!({"type":"kanban.supervisor.status","payload":{"requestId":"r-sup","data":{"boardId":"b1","status":"degraded"}}}),
            t0 + Duration::from_secs(1)
        ));
        assert!(!gate.admit(
            &json!({"type":"kanban.supervisor.status","payload":{"data":{"boardId":"b1","status":"degraded"}}}),
            t0 + Duration::from_secs(2)
        ));
        assert!(gate.admit(
            &json!({"type":"kanban.supervisor.status","payload":{"data":{"boardId":"b1","status":"healthy"}}}),
            t0 + Duration::from_secs(3)
        ));
    }

    #[test]
    fn events_leaves_incomplete_multibyte_utf8_tail_for_next_read() {
        let path = std::env::temp_dir().join(format!(
            "desktop-engine-utf8-tail-{}.events.jsonl",
            uuid::Uuid::new_v4()
        ));
        let line1 = b"{\"type\":\"session.title\",\"payload\":{\"title\":\"Caf\xc3\xa9\"}}\n";
        let part1 = b"{\"type\":\"text.delta\",\"payload\":{\"content\":\"\xf0\x9f";
        let part2 = b"\xa6\x80\"}}\n";
        {
            let mut file = File::create(&path).unwrap();
            file.write_all(line1).unwrap();
            file.write_all(part1).unwrap();
        }
        let first = Engine::events(&path, 0).unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(), 1);
        let offset = first["offset"].as_u64().unwrap();
        assert_eq!(offset, line1.len() as u64);

        {
            let mut file = OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(part2).unwrap();
        }
        let second = Engine::events(&path, offset).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(second["events"].as_array().unwrap().len(), 1);
        assert_eq!(second["events"][0]["payload"]["content"], "🦀");
    }
}
