use crate::{err, now, Result};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Serialize)]
struct Chunk<'a> {
    at: i64,
    bytes: &'a [u8],
}

pub struct Transcript {
    raw: File,
    jsonl: File,
}
impl Transcript {
    pub fn open(dir: &Path, id: &str) -> Result<Arc<Mutex<Self>>> {
        let file = |extension| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(format!("{id}.{extension}")))
                .map_err(err)
        };
        Ok(Arc::new(Mutex::new(Self {
            raw: file("bin")?,
            jsonl: file("jsonl")?,
        })))
    }
    pub fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.raw.write_all(bytes)?;
        // One write per chunk: serializing straight into the unbuffered file issued a write
        // call per JSON token, which capped a terminal at about 70 KB/s.
        let mut line = serde_json::to_vec(&Chunk { at: now(), bytes })?;
        line.push(b'\n');
        self.jsonl.write_all(&line)
    }
}

/// ConPTY INHERIT_CURSOR blocks startup until its first DSR is answered. The
/// host owns that handshake, even when no terminal pane has ever attached.
/// Remove it from the transcript so replays cannot inject stale cursor replies.
#[derive(Default)]
pub struct CursorHandshake {
    pending: Vec<u8>,
    done: bool,
}
impl CursorHandshake {
    pub fn feed(&mut self, bytes: &[u8]) -> (Vec<u8>, bool) {
        if self.done {
            return (bytes.to_vec(), false);
        }
        self.pending.extend_from_slice(bytes);
        let query = b"\x1b[6n";
        if let Some(index) = self.pending.windows(query.len()).position(|b| b == query) {
            self.pending.drain(index..index + query.len());
            self.done = true;
            return (std::mem::take(&mut self.pending), true);
        }
        let retained = (1..query.len())
            .rev()
            .find(|&n| self.pending.ends_with(&query[..n]))
            .unwrap_or(0);
        let emitted = self.pending.len() - retained;
        (self.pending.drain(..emitted).collect(), false)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consumes_only_initial_cursor_handshake_across_split_reads() {
        let mut h = CursorHandshake::default();
        assert_eq!(h.feed(b"before\x1b["), (b"before".to_vec(), false));
        assert_eq!(h.feed(b"6nready"), (b"ready".to_vec(), true));
        assert_eq!(h.feed(b"later\x1b[6n"), (b"later\x1b[6n".to_vec(), false));
    }
    #[test]
    fn appends_one_json_line_per_chunk_with_the_bytes_as_numbers() {
        let dir = std::env::temp_dir().join(format!("transcript-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sink = Transcript::open(&dir, "t").unwrap();
        sink.lock().unwrap().append(b"a\x1b").unwrap();
        sink.lock().unwrap().append(b"b").unwrap();
        let text = std::fs::read_to_string(dir.join("t.jsonl")).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["bytes"], serde_json::json!([97, 27]));
        assert!(lines[0]["at"].as_i64().unwrap() > 0);
        assert_eq!(std::fs::read(dir.join("t.bin")).unwrap(), b"a\x1bb");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn ordinary_output_and_unrelated_escape_sequences_are_preserved() {
        let mut h = CursorHandshake::default();
        assert_eq!(h.feed(b"hello"), (b"hello".to_vec(), false));
        assert_eq!(
            h.feed(b"\x1b[31mred\r\n"),
            (b"\x1b[31mred\r\n".to_vec(), false)
        );
    }
}
