//! Persistent native transport to WrongStack's backend. No frontend URL leaves
//! the host and no WebUI webview is created.
use crate::{err, now, Result};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::Duration,
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

/// Whether an engine message is a live browser frame that bypasses the event log.
pub(crate) fn is_live_frame(message: &Value) -> bool {
    message["type"] == "browser.live.frame"
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
    use super::{is_live_frame, scope_message, stamp_frame, Engine};
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

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
            json!({"type":"large","payload":{"text":"x".repeat(262144)}})
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

        fs::write(&path, small.repeat(201)).unwrap();
        let first = Engine::events(&path, 0).unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(), 200);
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
        thread::spawn(move || {
            let record = |log: &mut File, message: &Value| -> std::io::Result<()> {
                serde_json::to_writer(&mut *log, message)?;
                log.write_all(b"\n")
            };
            let result = (|| -> Result<()> {
                loop {
                    while let Ok(mut message) = receiver.try_recv() {
                        let identity = owner.identity.lock().map_err(err)?;
                        scope_message(&mut message, &identity, bind_session);
                        drop(identity);
                        socket
                            .send(Message::Text(message.to_string().into()))
                            .map_err(err)?;
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
                            stamp_frame(&mut message, now());
                            record(&mut log, &message).map_err(err)?;
                        }
                        Ok(Message::Ping(_)) => {
                            socket.flush().map_err(err)?;
                        }
                        Ok(Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e))
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(e) => return Err(err(e)),
                    }
                }
                Ok(())
            })();
            owner.connected.store(false, Ordering::Release);
            let _ = record(
                &mut log,
                &json!({"type":"desktop.disconnected","payload":{"message":result.err().unwrap_or_else(||"Engine connection closed".into())}}),
            );
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
        let len = file.metadata().map_err(err)?.len();
        let start = len.saturating_sub(65536);
        file.seek(SeekFrom::Start(start)).map_err(err)?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail).map_err(err)?;
        // A line still being written is left for the next read.
        let end = tail
            .iter()
            .take((len - start) as usize)
            .rposition(|byte| *byte == b'\n')
            .map_or(start, |at| start + at as u64 + 1);
        Ok(json!({"offset":end,"events":[],"hasMore":false,"tail":true}))
    }
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
        for _ in 0..200 {
            let mut line = String::new();
            let read = reader.read_line(&mut line).map_err(err)?;
            if read == 0 || !line.ends_with('\n') {
                break;
            }
            cursor += read as u64;
            events.push(serde_json::from_str::<Value>(&line).map_err(err)?);
            if cursor - offset >= 262144 {
                break;
            }
        }
        let has_more = events.len() == 200 || cursor - offset >= 262144;
        Ok(json!({"offset":cursor,"events":events,"hasMore":has_more,"size":size}))
    }
    pub fn event_path(&self) -> &Path {
        &self.path
    }
}
