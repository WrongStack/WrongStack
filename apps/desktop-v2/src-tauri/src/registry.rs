use crate::{err, now, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub kind: String,
    pub workdir: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

pub struct Registry {
    db: Connection,
    pub dir: PathBuf,
}
impl Registry {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(err)?;
        let db = Connection::open(dir.join("workspace.sqlite")).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(err)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, kind TEXT NOT NULL, workdir TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, exit_code INTEGER, error TEXT);
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS profile_form_drafts (form_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT, updated_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS project_form_drafts (project_id TEXT NOT NULL REFERENCES projects(id), form_key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,form_key));
          CREATE TABLE IF NOT EXISTS draft_revisions (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, part TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(session_id, part));
          CREATE TRIGGER IF NOT EXISTS draft_revision_insert AFTER INSERT ON settings WHEN NEW.key LIKE 'draft:%' OR NEW.key LIKE 'draftrefs:%' OR NEW.key LIKE 'draftmedia:%' OR NEW.key LIKE 'draftmode:%' BEGIN
            INSERT INTO draft_revisions(session_id,part,revision)
              SELECT id, CASE NEW.key WHEN 'draft:'||id THEN 'text' WHEN 'draftrefs:'||id THEN 'references' WHEN 'draftmedia:'||id THEN 'attachments' ELSE 'mode' END, 1
              FROM sessions WHERE kind='agent' AND id=CASE WHEN NEW.key LIKE 'draft:%' THEN substr(NEW.key,7) WHEN NEW.key LIKE 'draftrefs:%' THEN substr(NEW.key,11) WHEN NEW.key LIKE 'draftmedia:%' THEN substr(NEW.key,12) ELSE substr(NEW.key,11) END
              ON CONFLICT(session_id,part) DO UPDATE SET revision=revision+1;
          END;
          CREATE TRIGGER IF NOT EXISTS draft_revision_update AFTER UPDATE OF value ON settings WHEN NEW.key LIKE 'draft:%' OR NEW.key LIKE 'draftrefs:%' OR NEW.key LIKE 'draftmedia:%' OR NEW.key LIKE 'draftmode:%' BEGIN
            INSERT INTO draft_revisions(session_id,part,revision)
              SELECT id, CASE NEW.key WHEN 'draft:'||id THEN 'text' WHEN 'draftrefs:'||id THEN 'references' WHEN 'draftmedia:'||id THEN 'attachments' ELSE 'mode' END, 1
              FROM sessions WHERE kind='agent' AND id=CASE WHEN NEW.key LIKE 'draft:%' THEN substr(NEW.key,7) WHEN NEW.key LIKE 'draftrefs:%' THEN substr(NEW.key,11) WHEN NEW.key LIKE 'draftmedia:%' THEN substr(NEW.key,12) ELSE substr(NEW.key,11) END
              ON CONFLICT(session_id,part) DO UPDATE SET revision=revision+1;
          END;
          CREATE TRIGGER IF NOT EXISTS draft_revision_delete AFTER DELETE ON settings WHEN OLD.key LIKE 'draft:%' OR OLD.key LIKE 'draftrefs:%' OR OLD.key LIKE 'draftmedia:%' OR OLD.key LIKE 'draftmode:%' BEGIN
            INSERT INTO draft_revisions(session_id,part,revision)
              SELECT id, CASE OLD.key WHEN 'draft:'||id THEN 'text' WHEN 'draftrefs:'||id THEN 'references' WHEN 'draftmedia:'||id THEN 'attachments' ELSE 'mode' END, 1
              FROM sessions WHERE kind='agent' AND id=CASE WHEN OLD.key LIKE 'draft:%' THEN substr(OLD.key,7) WHEN OLD.key LIKE 'draftrefs:%' THEN substr(OLD.key,11) WHEN OLD.key LIKE 'draftmedia:%' THEN substr(OLD.key,12) ELSE substr(OLD.key,11) END
              ON CONFLICT(session_id,part) DO UPDATE SET revision=revision+1;
          END;").map_err(err)?;
        Ok(Self {
            db,
            dir: dir.to_owned(),
        })
    }
    pub fn register(&self, root: &str) -> Result<Project> {
        let path = std::fs::canonicalize(root).map_err(err)?;
        if !path.is_dir() {
            return Err("Project root must be a directory".into());
        }
        let canonical = path.to_string_lossy().into_owned();
        if let Some(project) = self.projects()?.into_iter().find(|p| p.root == canonical) {
            return Ok(project);
        }
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            root: canonical,
            created_at: now(),
        };
        self.db
            .execute(
                "INSERT INTO projects VALUES (?1,?2,?3,?4)",
                params![project.id, project.name, project.root, project.created_at],
            )
            .map_err(err)?;
        Ok(project)
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let mut q = self
            .db
            .prepare("SELECT id,name,root,created_at FROM projects ORDER BY created_at")
            .map_err(err)?;
        let rows = q
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    root: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })
            .map_err(err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)
    }
    pub fn workdir(&self, project_id: &str, requested: Option<&str>) -> Result<PathBuf> {
        let project = self
            .projects()?
            .into_iter()
            .find(|p| p.id == project_id)
            .ok_or("Unknown project")?;
        let root = PathBuf::from(project.root);
        let path = requested.map(PathBuf::from).unwrap_or_else(|| root.clone());
        let path = std::fs::canonicalize(if path.is_absolute() {
            path
        } else {
            root.join(path)
        })
        .map_err(err)?;
        if !path.is_dir() || !path.starts_with(&root) {
            return Err("Workdir must be inside the registered project".into());
        }
        Ok(path)
    }
    pub fn insert(&self, s: &Session) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO sessions VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    s.id,
                    s.project_id,
                    s.title,
                    s.kind,
                    s.workdir,
                    s.status,
                    s.created_at,
                    s.updated_at,
                    s.exit_code,
                    s.error
                ],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn sessions(&self) -> Result<Vec<Session>> {
        let mut q = self.db.prepare("SELECT id,project_id,title,kind,workdir,status,created_at,updated_at,exit_code,error FROM sessions ORDER BY created_at DESC").map_err(err)?;
        let rows = q
            .query_map([], |r| {
                Ok(Session {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    kind: r.get(3)?,
                    workdir: r.get(4)?,
                    status: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                    exit_code: r.get(8)?,
                    error: r.get(9)?,
                })
            })
            .map_err(err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)
    }
    pub fn state(
        &self,
        id: &str,
        status: &str,
        code: Option<i32>,
        error: Option<&str>,
    ) -> Result<()> {
        self.db
            .execute(
                "UPDATE sessions SET status=?2,updated_at=?3,exit_code=?4,error=?5 WHERE id=?1",
                params![id, status, now(), code, error],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn recover(&self) -> Result<()> {
        self.db.execute("UPDATE sessions SET status='interrupted',error='Session host stopped. Transcript is available; start a new session to continue.' WHERE status IN ('running','starting')", []).map_err(err)?;
        Ok(())
    }
    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        self.db
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)
    }
    fn ensure_form_project(&self, project_id: &str, form_key: &str) -> Result<()> {
        let record_form = form_key
            .strip_prefix("requirements-record:")
            .is_some_and(|id| {
                id.starts_with("reqi_")
                    && id.len() <= 100
                    && id.bytes().all(|value| {
                        value.is_ascii_alphanumeric() || value == b'_' || value == b'-'
                    })
            });
        // Typed-but-not-yet-added resource inputs for the new form or one recorded intake.
        let resource_input = form_key
            .strip_prefix("requirement-resource-input:")
            .is_some_and(|owner| {
                owner == "new"
                    || (owner.starts_with("reqi_")
                        && owner.len() <= 100
                        && owner.bytes().all(|value| {
                            value.is_ascii_alphanumeric() || value == b'_' || value == b'-'
                        }))
            });
        let file_form = form_key
            .strip_prefix("file-draft:")
            .is_some_and(|id| id.len() == 64 && id.bytes().all(|value| value.is_ascii_hexdigit()));
        let review_form = form_key
            .strip_prefix("chimera-note:")
            .is_some_and(|id| id.len() == 64 && id.bytes().all(|value| value.is_ascii_hexdigit()));
        let hashed_form = [
            "kit-parameters:",
            "skill-editor:",
            "roster-document:",
            "roster-runtime:",
            "automation-environment:",
            "btw-receipts:",
        ]
        .iter()
        .any(|prefix| {
            form_key.strip_prefix(prefix).is_some_and(|id| {
                id.len() == 64 && id.bytes().all(|value| value.is_ascii_hexdigit())
            })
        });
        if form_key != "requirements-new"
            && form_key != "history-view"
            && form_key != "git-review-notes"
            && form_key != "design-edits"
            && form_key != "roster-inputs"
            && form_key != "roster-create"
            && form_key != "mailbox-compose"
            && form_key != "automation-drafts"
            && !record_form
            && !resource_input
            && !file_form
            && !review_form
            && !hashed_form
        {
            return Err("Unknown project form".into());
        }
        if Uuid::parse_str(project_id).is_err()
            || !self
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                    [project_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(err)?
        {
            return Err("Unknown project".into());
        }
        Ok(())
    }
    pub fn form_draft(&self, project_id: &str, form_key: &str) -> Result<Value> {
        use rusqlite::OptionalExtension;
        self.ensure_form_project(project_id, form_key)?;
        let row = self.db.query_row("SELECT revision,payload,updated_at FROM project_form_drafts WHERE project_id=?1 AND form_key=?2", params![project_id,form_key], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?))).optional().map_err(err)?;
        let (revision, payload, updated_at) = row.unwrap_or((0, None, 0));
        let value = payload
            .map(|value| serde_json::from_str::<Value>(&value).map_err(err))
            .transpose()?
            .unwrap_or(Value::Null);
        Ok(serde_json::json!({"revision":revision,"value":value,"updatedAt":updated_at}))
    }
    fn ensure_profile_form(form_key: &str) -> Result<()> {
        let hashed = |prefix: &str| {
            form_key.strip_prefix(prefix).is_some_and(|id| {
                id.len() == 64 && id.bytes().all(|value| value.is_ascii_hexdigit())
            })
        };
        if !hashed("model-editor:") && !hashed("skill-editor:") {
            return Err("Unknown profile form".into());
        }
        Ok(())
    }
    pub fn profile_form_draft(&self, form_key: &str) -> Result<Value> {
        use rusqlite::OptionalExtension;
        Self::ensure_profile_form(form_key)?;
        let row = self
            .db
            .query_row(
                "SELECT revision,payload,updated_at FROM profile_form_drafts WHERE form_key=?1",
                [form_key],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(err)?;
        let (revision, payload, updated_at) = row.unwrap_or((0, None, 0));
        let value = payload
            .map(|value| serde_json::from_str::<Value>(&value).map_err(err))
            .transpose()?
            .unwrap_or(Value::Null);
        Ok(json!({"revision":revision,"value":value,"updatedAt":updated_at}))
    }
    pub fn save_profile_form_draft(
        &self,
        form_key: &str,
        value: &Value,
        expected: i64,
    ) -> Result<i64> {
        Self::ensure_profile_form(form_key)?;
        if expected < 0 || (!value.is_object() && !value.is_null()) {
            return Err("Invalid profile form draft".into());
        }
        let payload = if value.is_null() {
            None
        } else {
            Some(serde_json::to_string(value).map_err(err)?)
        };
        if payload
            .as_ref()
            .is_some_and(|text| text.len() > 2 * 1024 * 1024)
        {
            return Err("Profile draft exceeds the 2 MB storage limit".into());
        }
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        let result = (|| {
            let revision = self.profile_form_draft(form_key)?["revision"]
                .as_i64()
                .ok_or("Invalid profile draft revision")?;
            if revision != expected {
                return Err("DRAFT_CONFLICT: This profile draft changed in another window".into());
            }
            let next = revision
                .checked_add(1)
                .ok_or("Profile draft revision exhausted")?;
            self.db.execute("INSERT INTO profile_form_drafts(form_key,revision,payload,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(form_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at", params![form_key,next,payload,now()]).map_err(err)?;
            Ok(next)
        })();
        match result {
            Ok(next) => {
                if let Err(error) = self.db.execute_batch("COMMIT") {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(err(error));
                }
                Ok(next)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    /// Ownership summaries of every parked model-editor draft, across profiles and providers.
    /// Payload bodies stay behind `profile-draft.get`; only typed text fields are extracted.
    pub fn profile_form_drafts(&self) -> Result<Value> {
        const LIMIT: usize = 200;
        let text = |path: &str| {
            format!("CASE WHEN json_type(payload,'{path}')='text' THEN json_extract(payload,'{path}') END")
        };
        let sql = format!(
            "SELECT form_key,revision,updated_at,length(payload),json_type(payload,'$.version')='integer' AND json_extract(payload,'$.version')=1,{},{},{},{},{} FROM profile_form_drafts WHERE form_key LIKE 'model-editor:%' AND payload IS NOT NULL ORDER BY updated_at DESC,form_key LIMIT {}",
            text("$.providerId"),
            text("$.profileId"),
            text("$.profileName"),
            text("$.editor.originalId"),
            text("$.editor.draft.id"),
            LIMIT + 1
        );
        let mut query = self.db.prepare(&sql).map_err(err)?;
        let rows = query
            .query_map([], |row| {
                Ok(json!({
                    "formKey": row.get::<_, String>(0)?,
                    "revision": row.get::<_, i64>(1)?,
                    "updatedAt": row.get::<_, i64>(2)?,
                    "bytes": row.get::<_, i64>(3)?,
                    "supported": row.get::<_, Option<bool>>(4)?.unwrap_or(false),
                    "providerId": row.get::<_, Option<String>>(5)?,
                    "profileId": row.get::<_, Option<String>>(6)?,
                    "profileName": row.get::<_, Option<String>>(7)?,
                    "originalId": row.get::<_, Option<String>>(8)?,
                    "modelId": row.get::<_, Option<String>>(9)?,
                }))
            })
            .map_err(err)?;
        let mut drafts = rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let truncated = drafts.len() > LIMIT;
        drafts.truncate(LIMIT);
        Ok(json!({"drafts": drafts, "limit": LIMIT, "truncated": truncated}))
    }
    pub fn file_drafts(&self, project_id: &str) -> Result<Value> {
        self.ensure_form_project(project_id, &format!("file-draft:{}", "0".repeat(64)))?;
        let mut query = self.db.prepare("SELECT form_key,json_extract(payload,'$.path'),revision,updated_at FROM project_form_drafts WHERE project_id=?1 AND form_key LIKE 'file-draft:%' AND payload IS NOT NULL ORDER BY updated_at DESC,form_key LIMIT 500").map_err(err)?;
        let rows = query.query_map([project_id], |row| Ok(json!({"key":row.get::<_,String>(0)?,"path":row.get::<_,Option<String>>(1)?,"revision":row.get::<_,i64>(2)?,"updatedAt":row.get::<_,i64>(3)?}))).map_err(err)?;
        Ok(
            json!({"drafts": rows.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?,"limit":500}),
        )
    }
    pub fn save_form_draft(
        &self,
        project_id: &str,
        form_key: &str,
        value: &Value,
        expected: i64,
    ) -> Result<i64> {
        self.ensure_form_project(project_id, form_key)?;
        if expected < 0 || (!value.is_object() && !value.is_null()) {
            return Err("Invalid project form draft".into());
        }
        let payload = if value.is_null() {
            None
        } else {
            Some(serde_json::to_string(value).map_err(err)?)
        };
        if payload
            .as_ref()
            .is_some_and(|value| value.len() > 2 * 1024 * 1024)
        {
            return Err("Form draft exceeds the 2 MB storage limit".into());
        }
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        let result = (|| {
            let revision = self.form_draft(project_id, form_key)?["revision"]
                .as_i64()
                .ok_or("Invalid form revision")?;
            if revision != expected {
                return Err("DRAFT_CONFLICT: This project draft changed in another window".into());
            }
            let next = revision
                .checked_add(1)
                .ok_or("Form draft revision exhausted")?;
            self.db.execute("INSERT INTO project_form_drafts(project_id,form_key,revision,payload,updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(project_id,form_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at", params![project_id,form_key,next,payload,now()]).map_err(err)?;
            Ok(next)
        })();
        match result {
            Ok(next) => {
                if let Err(error) = self.db.execute_batch("COMMIT") {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(err(error));
                }
                Ok(next)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn draft(&self, id: &str) -> Result<String> {
        self.ensure_agent(id)?;
        Ok(self.setting(&format!("draft:{id}"))?.unwrap_or_default())
    }
    pub fn draft_revision(&self, id: &str, part: &str) -> Result<i64> {
        use rusqlite::OptionalExtension;
        self.ensure_agent(id)?;
        if ![
            "text",
            "references",
            "attachments",
            "mode",
            "plan",
            "refine",
        ]
        .contains(&part)
        {
            return Err("Unknown draft part".into());
        }
        Ok(self
            .db
            .query_row(
                "SELECT revision FROM draft_revisions WHERE session_id=?1 AND part=?2",
                params![id, part],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?
            .unwrap_or(0))
    }
    pub fn draft_snapshot(&self, id: &str) -> Result<Value> {
        self.db.execute_batch("BEGIN").map_err(err)?;
        let result = (|| {
            let references: Value =
                serde_json::from_str(&self.draft_part(id, "references")?).map_err(err)?;
            let attachments: Value =
                serde_json::from_str(&self.draft_part(id, "attachments")?).map_err(err)?;
            Ok(
                serde_json::json!({"text":self.draft(id)?,"references":references,"attachments":attachments,"mode":self.draft_mode(id)?,"revisions":{"text":self.draft_revision(id,"text")?,"references":self.draft_revision(id,"references")?,"attachments":self.draft_revision(id,"attachments")?,"mode":self.draft_revision(id,"mode")?}}),
            )
        })();
        match result {
            Ok(snapshot) => {
                self.db.execute_batch("COMMIT").map_err(err)?;
                Ok(snapshot)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn draft_revisions(&self, id: &str) -> Result<Value> {
        self.db.execute_batch("BEGIN").map_err(err)?;
        let result = (|| {
            Ok(
                serde_json::json!({"text":self.draft_revision(id,"text")?,"references":self.draft_revision(id,"references")?,"attachments":self.draft_revision(id,"attachments")?,"mode":self.draft_revision(id,"mode")?}),
            )
        })();
        match result {
            Ok(revisions) => {
                self.db.execute_batch("COMMIT").map_err(err)?;
                Ok(revisions)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn save_draft_checked(
        &self,
        id: &str,
        part: &str,
        value: &str,
        expected: i64,
    ) -> Result<i64> {
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        let result = (|| {
            let revision = self.draft_revision(id, part)?;
            if revision != expected {
                return Err("DRAFT_CONFLICT: This draft changed in another window".into());
            }
            match part {
                "text" => self.save_draft(id, value)?,
                "mode" => self.save_draft_mode(id, value)?,
                "references" | "attachments" => self.save_draft_part(id, part, value)?,
                "plan" | "refine" => self.save_draft_object(id, part, value)?,
                _ => return Err("Unknown draft part".into()),
            }
            let next = revision.checked_add(1).ok_or("Draft revision exhausted")?;
            if self.draft_revision(id, part)? == revision {
                // Clearing a field that was already absent changes no settings row.
                self.db.execute("INSERT INTO draft_revisions(session_id,part,revision) VALUES (?1,?2,?3) ON CONFLICT(session_id,part) DO UPDATE SET revision=excluded.revision", params![id,part,next]).map_err(err)?;
            }
            if self.draft_revision(id, part)? != next {
                return Err("Unexpected draft revision".into());
            }
            Ok(next)
        })();
        match result {
            Ok(next) => {
                if let Err(error) = self.db.execute_batch("COMMIT") {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(err(error));
                }
                Ok(next)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn replace_draft_checked(
        &self,
        id: &str,
        draft: &Value,
        expected: &Value,
    ) -> Result<Value> {
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        let result = (|| {
            let parts = ["text", "references", "attachments", "mode"];
            let mut revisions = Vec::new();
            for part in parts {
                let expected = expected[part]
                    .as_i64()
                    .filter(|value| *value >= 0)
                    .ok_or("Missing draft revision")?;
                let actual = self.draft_revision(id, part)?;
                if expected != actual {
                    return Err("DRAFT_CONFLICT: The saved draft changed again".into());
                }
                revisions.push(actual);
            }
            let text = draft["text"].as_str().ok_or("Missing draft text")?;
            let mode = draft["mode"].as_str().ok_or("Missing delivery mode")?;
            if !draft["references"].is_array() || !draft["attachments"].is_array() {
                return Err("Draft data must be a list".into());
            }
            self.save_draft(id, text)?;
            self.save_draft_part(id, "references", &draft["references"].to_string())?;
            self.save_draft_part(id, "attachments", &draft["attachments"].to_string())?;
            self.save_draft_mode(id, mode)?;
            for (part, previous) in parts.into_iter().zip(revisions) {
                let next = previous.checked_add(1).ok_or("Draft revision exhausted")?;
                if self.draft_revision(id, part)? == previous {
                    self.db.execute("INSERT INTO draft_revisions(session_id,part,revision) VALUES (?1,?2,?3) ON CONFLICT(session_id,part) DO UPDATE SET revision=excluded.revision", params![id,part,next]).map_err(err)?;
                }
                if self.draft_revision(id, part)? != next {
                    return Err("Unexpected draft revision".into());
                }
            }
            Ok(
                serde_json::json!({"text":self.draft_revision(id,"text")?,"references":self.draft_revision(id,"references")?,"attachments":self.draft_revision(id,"attachments")?,"mode":self.draft_revision(id,"mode")?}),
            )
        })();
        match result {
            Ok(revisions) => {
                if let Err(error) = self.db.execute_batch("COMMIT") {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(err(error));
                }
                Ok(revisions)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn draft_mode(&self, id: &str) -> Result<String> {
        self.ensure_agent(id)?;
        let mode = self
            .setting(&format!("draftmode:{id}"))?
            .unwrap_or_else(|| "btw".into());
        if !["btw", "queue", "steer"].contains(&mode.as_str()) {
            return Err("Invalid saved delivery mode".into());
        }
        Ok(mode)
    }
    pub fn save_draft_mode(&self, id: &str, mode: &str) -> Result<()> {
        self.ensure_agent(id)?;
        if !["btw", "queue", "steer"].contains(&mode) {
            return Err("Invalid delivery mode".into());
        }
        let key = format!("draftmode:{id}");
        if mode == "btw" {
            self.db
                .execute("DELETE FROM settings WHERE key=?1", [key])
                .map_err(err)?;
        } else {
            self.db.execute("INSERT INTO settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, mode]).map_err(err)?;
        }
        Ok(())
    }
    pub fn draft_part(&self, id: &str, part: &str) -> Result<String> {
        self.ensure_agent(id)?;
        let prefix = match part {
            "references" => "draftrefs",
            "attachments" => "draftmedia",
            _ => return Err("Unknown draft part".into()),
        };
        Ok(self
            .setting(&format!("{prefix}:{id}"))?
            .unwrap_or_else(|| "[]".into()))
    }
    /// Settings prefix and size limit of a session draft part stored as one JSON object.
    fn draft_object_part(part: &str) -> Result<(&'static str, usize)> {
        match part {
            "plan" => Ok(("draftplan", 512 * 1024)),
            "refine" => Ok(("draftrefine", 4 * 1024 * 1024)),
            _ => Err("Unknown draft part".into()),
        }
    }
    /// An object draft part of a session (model plan or refinement review) and its revision.
    pub fn draft_object(&self, id: &str, part: &str) -> Result<Value> {
        let (prefix, _) = Self::draft_object_part(part)?;
        self.db.execute_batch("BEGIN").map_err(err)?;
        let result = (|| {
            let value = match self.setting(&format!("{prefix}:{id}"))? {
                Some(text) => serde_json::from_str(&text).map_err(err)?,
                None => Value::Null,
            };
            Ok(serde_json::json!({"value":value,"revision":self.draft_revision(id,part)?}))
        })();
        match result {
            Ok(snapshot) => {
                self.db.execute_batch("COMMIT").map_err(err)?;
                Ok(snapshot)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    fn save_draft_object(&self, id: &str, part: &str, value: &str) -> Result<()> {
        let (prefix, limit) = Self::draft_object_part(part)?;
        self.ensure_agent(id)?;
        if value.len() > limit {
            return Err("Draft data exceeds the storage limit".into());
        }
        let key = format!("{prefix}:{id}");
        if value.is_empty() {
            self.db
                .execute("DELETE FROM settings WHERE key=?1", [key])
                .map_err(err)?;
            return Ok(());
        }
        let parsed: Value = serde_json::from_str(value).map_err(err)?;
        if !parsed.is_object() {
            return Err("An object draft part must be an object".into());
        }
        self.db.execute("INSERT INTO settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map_err(err)?;
        Ok(())
    }
    fn ensure_agent(&self, id: &str) -> Result<()> {
        if Uuid::parse_str(id).is_err()
            || !self
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND kind='agent')",
                    [id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(err)?
        {
            return Err("Unknown agent session".into());
        }
        Ok(())
    }
    pub fn save_draft(&self, id: &str, text: &str) -> Result<()> {
        self.ensure_agent(id)?;
        if text.len() > 2 * 1024 * 1024 {
            return Err("Draft exceeds the 2 MB storage limit".into());
        }
        let key = format!("draft:{id}");
        if text.is_empty() {
            self.db
                .execute("DELETE FROM settings WHERE key=?1", [key])
                .map_err(err)?;
        } else {
            self.db.execute("INSERT INTO settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, text]).map_err(err)?;
        }
        Ok(())
    }
    pub fn save_draft_part(&self, id: &str, part: &str, value: &str) -> Result<()> {
        self.ensure_agent(id)?;
        let (prefix, limit) = match part {
            "references" => ("draftrefs", 2 * 1024 * 1024),
            "attachments" => ("draftmedia", 18 * 1024 * 1024),
            _ => return Err("Unknown draft part".into()),
        };
        if value.len() > limit {
            return Err("Draft data exceeds the storage limit".into());
        }
        let parsed: Value = serde_json::from_str(value).map_err(err)?;
        if !parsed.is_array() {
            return Err("Draft data must be a list".into());
        }
        let key = format!("{prefix}:{id}");
        if parsed.as_array().is_some_and(|items| items.is_empty()) {
            self.db
                .execute("DELETE FROM settings WHERE key=?1", [key])
                .map_err(err)?;
        } else {
            self.db.execute("INSERT INTO settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map_err(err)?;
        }
        Ok(())
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        if key != "layout"
            && key != "appearance"
            && !key
                .strip_prefix("layout:")
                .is_some_and(|id| Uuid::parse_str(id).is_ok())
        {
            return Err("Unknown setting".into());
        }
        self.db.execute("INSERT INTO settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key,value]).map_err(err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_model_drafts_need_no_projects_and_use_revision_checked_cleanup() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let db = super::Registry::open(&dir).unwrap();
        let key = format!("model-editor:{}", "a".repeat(64));
        let other = format!("model-editor:{}", "b".repeat(64));
        assert!(db.projects().unwrap().is_empty());
        assert_eq!(db.profile_form_draft(&key).unwrap()["revision"], 0);
        let value =
            serde_json::json!({"version":1,"providerId":"one","editor":{"draft":"in progress"}});
        assert_eq!(db.save_profile_form_draft(&key, &value, 0).unwrap(), 1);
        let peer = super::Registry::open(&dir).unwrap();
        assert_eq!(peer.profile_form_draft(&key).unwrap()["value"], value);
        assert!(peer.profile_form_draft(&other).unwrap()["value"].is_null());
        assert!(peer
            .save_profile_form_draft(&key, &serde_json::Value::Null, 0)
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        assert_eq!(
            peer.save_profile_form_draft(&key, &serde_json::json!({"newer":true}), 1)
                .unwrap(),
            2
        );
        assert!(db
            .save_profile_form_draft(&key, &serde_json::Value::Null, 1)
            .is_err());
        assert!(db
            .save_profile_form_draft(&key, &serde_json::json!([]), 2)
            .is_err());
        assert!(db.profile_form_draft("model-editor:../bad").is_err());
        assert!(db.profile_form_draft("requirements-new").is_err());
        let skill = format!("skill-editor:{}", "e".repeat(64));
        assert_eq!(db.save_profile_form_draft(&skill, &value, 0).unwrap(), 1);
        assert!(db.profile_form_draft("skill-editor:short").is_err());
        assert!(db.save_profile_form_draft(&key, &value, -1).is_err());
        assert!(db
            .save_profile_form_draft(
                &other,
                &serde_json::json!({"text":"x".repeat(2 * 1024 * 1024)}),
                0
            )
            .is_err());
        assert_eq!(
            db.save_profile_form_draft(&key, &serde_json::Value::Null, 2)
                .unwrap(),
            3
        );
        drop(peer);
        drop(db);
        let reopened = super::Registry::open(&dir).unwrap();
        assert_eq!(reopened.profile_form_draft(&key).unwrap()["revision"], 3);
        assert!(reopened.profile_form_draft(&key).unwrap()["value"].is_null());
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn profile_draft_listing_reports_typed_ownership_without_bodies() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let db = super::Registry::open(&dir).unwrap();
        let key = |seed: &str| format!("model-editor:{}", seed.repeat(64));
        let owned = serde_json::json!({"version":1,"providerId":"gone","profileId":"f".repeat(64),"profileName":"work","editor":{"originalId":"","draft":{"id":"custom-x","secret":"body"}}});
        db.save_profile_form_draft(&key("a"), &owned, 0).unwrap();
        let mistyped =
            serde_json::json!({"version":"1","providerId":7,"editor":{"draft":{"id":["x"]}}});
        db.save_profile_form_draft(&key("b"), &mistyped, 0).unwrap();
        db.save_profile_form_draft(&key("c"), &owned, 0).unwrap();
        db.save_profile_form_draft(&key("c"), &serde_json::Value::Null, 1)
            .unwrap();
        let listed = db.profile_form_drafts().unwrap();
        let drafts = listed["drafts"].as_array().unwrap();
        assert_eq!(drafts.len(), 2, "cleared drafts are not listed");
        assert_eq!(listed["truncated"], false);
        let first = drafts
            .iter()
            .find(|row| row["formKey"] == key("a"))
            .unwrap();
        assert_eq!(first["providerId"], "gone");
        assert_eq!(first["profileName"], "work");
        assert_eq!(first["modelId"], "custom-x");
        assert_eq!(first["originalId"], "");
        assert_eq!(first["supported"], true);
        assert_eq!(first["revision"], 1);
        assert!(!first.to_string().contains("body"));
        let second = drafts
            .iter()
            .find(|row| row["formKey"] == key("b"))
            .unwrap();
        assert_eq!(second["supported"], false);
        assert!(second["providerId"].is_null() && second["modelId"].is_null());
        assert!(second["profileId"].is_null());
        for index in 0..201 {
            db.save_profile_form_draft(
                &format!("model-editor:{index:064x}"),
                &serde_json::json!({"version":1}),
                0,
            )
            .unwrap();
        }
        let bounded = db.profile_form_drafts().unwrap();
        assert_eq!(bounded["drafts"].as_array().unwrap().len(), 200);
        assert_eq!(bounded["truncated"], true);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
    use super::*;
    #[test]
    fn file_drafts_are_project_scoped_persistent_metadata_with_checked_clears() {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        let db = Registry::open(&dir.join("state")).unwrap();
        let a = db.register(&dir.join("a").to_string_lossy()).unwrap();
        let b = db.register(&dir.join("b").to_string_lossy()).unwrap();
        let key = format!("file-draft:{}", "a".repeat(64));
        let value = json!({"version":1,"path":"src/a.ts","content":"draft","saved":"original"});
        assert_eq!(db.save_form_draft(&a.id, &key, &value, 0).unwrap(), 1);
        assert!(db.file_drafts(&b.id).unwrap()["drafts"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(db.form_draft(&a.id, "file-draft:../bad").is_err());
        drop(db);
        let reopened = Registry::open(&dir.join("state")).unwrap();
        let list = reopened.file_drafts(&a.id).unwrap();
        assert_eq!(list["drafts"][0]["path"], "src/a.ts");
        assert!(list["drafts"][0].get("content").is_none());
        assert_eq!(reopened.form_draft(&a.id, &key).unwrap()["value"], value);
        assert!(reopened
            .save_form_draft(&a.id, &key, &Value::Null, 0)
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        reopened
            .save_form_draft(&a.id, &key, &Value::Null, 1)
            .unwrap();
        assert!(reopened.file_drafts(&a.id).unwrap()["drafts"]
            .as_array()
            .unwrap()
            .is_empty());
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn project_form_drafts_persist_and_reject_stale_windows_and_clears() {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        let db = Registry::open(&dir.join("state")).unwrap();
        let a = db.register(dir.join("a").to_str().unwrap()).unwrap();
        let b = db.register(dir.join("b").to_str().unwrap()).unwrap();
        let key = "requirements-new";
        let record_key = "requirements-record:reqi_one";
        assert_eq!(
            db.save_form_draft(&a.id, record_key, &serde_json::json!({"answer":"one"}), 0)
                .unwrap(),
            1
        );
        assert!(db
            .form_draft(&a.id, "requirements-record:reqi_two")
            .unwrap()["value"]
            .is_null());
        assert!(db.form_draft(&b.id, record_key).unwrap()["value"].is_null());
        assert!(db
            .form_draft(&a.id, "requirements-record:reqi_../one")
            .is_err());
        assert_eq!(db.form_draft(&a.id, key).unwrap()["revision"], 0);
        let value =
            serde_json::json!({"original":"Keep exact text\n","resources":["docs/design.md"]});
        assert_eq!(db.save_form_draft(&a.id, key, &value, 0).unwrap(), 1);
        let peer = Registry::open(&dir.join("state")).unwrap();
        let note_key = format!("chimera-note:{}", "a".repeat(64));
        let history_key = "history-view";
        let history_value = serde_json::json!({"version":1,"view":{"pageSize":200,"query":"release","provider":"local","outcome":"completed","includeEmpty":false,"selectedId":"recorded/session","anchorId":"first/row"}});
        assert_eq!(
            db.save_form_draft(&a.id, history_key, &history_value, 0)
                .unwrap(),
            1
        );
        assert_eq!(
            peer.form_draft(&a.id, history_key).unwrap()["value"],
            history_value
        );
        assert!(peer.form_draft(&b.id, history_key).unwrap()["value"].is_null());
        assert!(peer
            .save_form_draft(&a.id, history_key, &Value::Null, 0)
            .is_err());
        let note_value = serde_json::json!({"version":1,"reportId":"recorded/report","text":"Retain exact note\n"});
        assert_eq!(
            db.save_form_draft(&a.id, &note_key, &note_value, 0)
                .unwrap(),
            1
        );
        assert_eq!(
            peer.form_draft(&a.id, &note_key).unwrap()["value"],
            note_value
        );
        assert!(peer.form_draft(&b.id, &note_key).unwrap()["value"].is_null());
        assert!(peer
            .form_draft(&a.id, &format!("chimera-note:{}", "b".repeat(64)))
            .unwrap()["value"]
            .is_null());
        assert!(peer
            .save_form_draft(&a.id, &note_key, &Value::Null, 0)
            .is_err());
        assert!(peer.form_draft(&a.id, "chimera-note:../invalid").is_err());
        let kit_key = format!("kit-parameters:{}", "c".repeat(64));
        let kit_value =
            serde_json::json!({"version":1,"kit":"release.notes","input":{"count":null}});
        assert_eq!(
            db.save_form_draft(&a.id, &kit_key, &kit_value, 0).unwrap(),
            1
        );
        assert_eq!(
            peer.form_draft(&a.id, &kit_key).unwrap()["value"],
            kit_value
        );
        assert!(peer.form_draft(&b.id, &kit_key).unwrap()["value"].is_null());
        assert!(peer
            .save_form_draft(&a.id, &kit_key, &Value::Null, 0)
            .is_err());
        assert!(peer
            .form_draft(&a.id, "kit-parameters:release.notes")
            .is_err());
        let skill_key = format!("skill-editor:{}", "d".repeat(64));
        assert_eq!(
            db.save_form_draft(&a.id, &skill_key, &kit_value, 0)
                .unwrap(),
            1
        );
        assert!(peer.form_draft(&b.id, &skill_key).unwrap()["value"].is_null());
        let design =
            serde_json::json!({"version":1,"kit":"aurora","colors":{"light.accent":"#123456"}});
        assert_eq!(
            db.save_form_draft(&a.id, "design-edits", &design, 0)
                .unwrap(),
            1
        );
        assert_eq!(
            peer.form_draft(&a.id, "design-edits").unwrap()["value"],
            design
        );
        assert!(peer.form_draft(&b.id, "design-edits").unwrap()["value"].is_null());
        assert!(peer.form_draft(&a.id, "design-edits-x").is_err());
        assert_eq!(
            db.save_form_draft(&a.id, "roster-inputs", &design, 0)
                .unwrap(),
            1
        );
        assert!(peer.form_draft(&b.id, "roster-inputs").unwrap()["value"].is_null());
        assert_eq!(
            db.save_form_draft(&a.id, "roster-create", &design, 0)
                .unwrap(),
            1
        );
        assert_eq!(
            db.save_form_draft(&a.id, "mailbox-compose", &design, 0)
                .unwrap(),
            1
        );
        assert!(peer.form_draft(&b.id, "mailbox-compose").unwrap()["value"].is_null());
        assert_eq!(
            db.save_form_draft(&a.id, "automation-drafts", &design, 0)
                .unwrap(),
            1
        );
        assert!(peer.form_draft(&b.id, "automation-drafts").unwrap()["value"].is_null());
        let roster = format!("roster-document:{}", "9".repeat(64));
        assert_eq!(db.save_form_draft(&a.id, &roster, &design, 0).unwrap(), 1);
        assert!(peer.form_draft(&a.id, "roster-document:reviewer").is_err());
        let runtime = format!("roster-runtime:{}", "8".repeat(64));
        assert_eq!(db.save_form_draft(&a.id, &runtime, &design, 0).unwrap(), 1);
        let environment = format!("automation-environment:{}", "7".repeat(64));
        assert_eq!(
            db.save_form_draft(&a.id, &environment, &design, 0).unwrap(),
            1
        );
        assert!(peer
            .form_draft(&a.id, "automation-environment:job-1")
            .is_err());
        let receipts = format!("btw-receipts:{}", "6".repeat(64));
        assert_eq!(db.save_form_draft(&a.id, &receipts, &design, 0).unwrap(), 1);
        assert!(peer.form_draft(&a.id, "btw-receipts:session-1").is_err());
        for owner in ["new", "reqi_01ABC-def"] {
            let key = format!("requirement-resource-input:{owner}");
            assert_eq!(db.save_form_draft(&a.id, &key, &design, 0).unwrap(), 1);
            assert!(peer.form_draft(&b.id, &key).unwrap()["value"].is_null());
        }
        for bad in [
            "requirement-resource-input:",
            "requirement-resource-input:reqi_../x",
        ] {
            assert!(peer.form_draft(&a.id, bad).is_err());
        }
        let review_key = "git-review-notes";
        let review = serde_json::json!({"version":1,"notes":[{"path":"src/main.rs","line":3,"text":"Check this boundary"}]});
        assert_eq!(
            db.save_form_draft(&a.id, review_key, &review, 0).unwrap(),
            1
        );
        assert_eq!(peer.form_draft(&a.id, review_key).unwrap()["value"], review);
        assert!(peer.form_draft(&b.id, review_key).unwrap()["value"].is_null());
        assert!(peer
            .save_form_draft(&a.id, review_key, &Value::Null, 0)
            .is_err());
        assert_eq!(peer.form_draft(&a.id, key).unwrap()["value"], value);
        assert!(peer.form_draft(&b.id, key).unwrap()["value"].is_null());
        assert!(peer
            .save_form_draft(&a.id, key, &Value::Null, 0)
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        assert_eq!(
            peer.save_form_draft(&a.id, key, &serde_json::json!({"original":"Newer"}), 1)
                .unwrap(),
            2
        );
        assert!(db.save_form_draft(&a.id, key, &Value::Null, 1).is_err());
        assert_eq!(db.save_form_draft(&a.id, key, &Value::Null, 2).unwrap(), 3);
        assert!(peer.save_form_draft(&a.id, key, &value, 2).is_err());
        assert!(db.form_draft("missing", key).is_err());
        assert!(db.form_draft(&a.id, "other-form").is_err());
        assert!(db
            .save_form_draft(&a.id, key, &serde_json::json!([]), 3)
            .is_err());
        drop(peer);
        drop(db);
        let reopened = Registry::open(&dir.join("state")).unwrap();
        assert_eq!(
            reopened.form_draft(&a.id, &note_key).unwrap()["value"],
            note_value
        );
        assert_eq!(
            reopened.form_draft(&a.id, history_key).unwrap()["value"],
            history_value
        );
        assert_eq!(
            reopened.form_draft(&a.id, review_key).unwrap()["value"],
            review
        );
        assert_eq!(reopened.form_draft(&a.id, key).unwrap()["revision"], 3);
        assert!(reopened.form_draft(&a.id, key).unwrap()["value"].is_null());
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn registry_persists_projects_sessions_and_rejects_escape() {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let project_dir = dir.join("repo");
        std::fs::create_dir_all(project_dir.join("src")).unwrap();
        let db = Registry::open(&dir.join("state")).unwrap();
        let p = db.register(project_dir.to_str().unwrap()).unwrap();
        assert_eq!(p.id, db.register(project_dir.to_str().unwrap()).unwrap().id);
        assert!(db.workdir(&p.id, Some("src")).is_ok());
        assert!(db.workdir(&p.id, Some("..")).is_err());
        assert!(db.workdir("missing", None).is_err());
        let s = Session {
            id: Uuid::new_v4().to_string(),
            project_id: p.id,
            title: "test".into(),
            kind: "terminal".into(),
            workdir: project_dir.to_string_lossy().into(),
            status: "running".into(),
            created_at: now(),
            updated_at: now(),
            exit_code: None,
            error: None,
        };
        db.insert(&s).unwrap();
        let a = Session {
            id: Uuid::new_v4().to_string(),
            kind: "agent".into(),
            ..s.clone()
        };
        let b = Session {
            id: Uuid::new_v4().to_string(),
            kind: "agent".into(),
            ..s.clone()
        };
        db.insert(&a).unwrap();
        db.insert(&b).unwrap();
        db.save_draft(&a.id, "first project draft").unwrap();
        db.save_draft(&b.id, "second project draft").unwrap();
        db.save_draft_mode(&a.id, "queue").unwrap();
        assert!(db.save_draft_mode(&a.id, "unsupported").is_err());
        let refs = r#"[{"path":"src/app.ts"}]"#;
        let media = r#"[{"id":"one","name":"image.png","mediaType":"image/png","data":"AA+/==","bytes":3}]"#;
        db.save_draft_part(&a.id, "references", refs).unwrap();
        db.save_draft_part(&a.id, "attachments", media).unwrap();
        assert!(db.save_draft_part(&a.id, "attachments", "{}").is_err());
        assert!(db.save_draft_part(&a.id, "unknown", "[]").is_err());
        assert!(db.save_draft(&s.id, "terminal").is_err());
        assert!(db
            .save_draft(&Uuid::new_v4().to_string(), "unknown")
            .is_err());
        db.set_setting("appearance", "{\"mode\":\"light\",\"accent\":\"ocean\"}")
            .unwrap();
        assert!(db.set_setting("unknown", "value").is_err());
        drop(db);
        let db = Registry::open(&dir.join("state")).unwrap();
        assert_eq!(
            db.setting("appearance").unwrap().as_deref(),
            Some("{\"mode\":\"light\",\"accent\":\"ocean\"}")
        );
        assert_eq!(db.draft(&a.id).unwrap(), "first project draft");
        assert_eq!(db.draft(&b.id).unwrap(), "second project draft");
        assert_eq!(db.draft_mode(&a.id).unwrap(), "queue");
        assert_eq!(db.draft_mode(&b.id).unwrap(), "btw");
        let base = db.draft_revision(&a.id, "text").unwrap();
        assert_eq!(base, 1);
        assert_eq!(
            db.save_draft_checked(&a.id, "text", "first window", base)
                .unwrap(),
            base + 1
        );
        let peer = Registry::open(&dir.join("state")).unwrap();
        assert!(peer
            .save_draft_checked(&a.id, "text", "stale window", base)
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        assert_eq!(peer.draft(&a.id).unwrap(), "first window");
        let media_base = db.draft_revision(&a.id, "attachments").unwrap();
        assert_eq!(
            peer.save_draft_checked(&a.id, "attachments", media, media_base)
                .unwrap(),
            media_base + 1
        );
        assert!(db
            .save_draft_checked(&a.id, "attachments", "[]", media_base)
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        assert_eq!(
            serde_json::from_str::<Value>(&db.draft_part(&a.id, "attachments").unwrap()).unwrap(),
            serde_json::from_str::<Value>(media).unwrap()
        );
        let mode_base = db.draft_revision(&a.id, "mode").unwrap();
        assert_eq!(
            peer.save_draft_checked(&a.id, "mode", "queue", mode_base)
                .unwrap(),
            mode_base + 1
        );
        assert_eq!(
            peer.save_draft_checked(&a.id, "text", "second window", base + 1)
                .unwrap(),
            base + 2
        );
        assert_eq!(db.draft(&a.id).unwrap(), "second window");
        let legacy_base = db.draft_revision(&a.id, "text").unwrap();
        peer.save_draft(&a.id, "older client edit").unwrap();
        assert!(db
            .save_draft_checked(&a.id, "text", "stale newer client", legacy_base)
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        assert_eq!(db.draft(&a.id).unwrap(), "older client edit");
        // Session model plan drafts: object-only, revision-checked, isolated per session.
        assert!(db.draft_object(&a.id, "plan").unwrap()["value"].is_null());
        assert_eq!(db.draft_object(&a.id, "plan").unwrap()["revision"], 0);
        assert!(db
            .save_draft_checked(&a.id, "plan", "[1]", 0)
            .unwrap_err()
            .contains("object"));
        assert_eq!(
            db.save_draft_checked(&a.id, "plan", "{\"version\":1}", 0)
                .unwrap(),
            1
        );
        assert!(peer
            .save_draft_checked(&a.id, "plan", "{\"version\":2}", 0)
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        assert_eq!(
            peer.draft_object(&a.id, "plan").unwrap()["value"]["version"],
            1
        );
        assert!(peer.draft_object(&b.id, "plan").unwrap()["value"].is_null());
        assert_eq!(peer.save_draft_checked(&a.id, "plan", "", 1).unwrap(), 2);
        // The refinement review is a separate object part with its own revision.
        assert_eq!(
            db.save_draft_checked(&a.id, "refine", "{\"version\":1}", 0)
                .unwrap(),
            1
        );
        assert_eq!(db.draft_object(&a.id, "refine").unwrap()["revision"], 1);
        assert!(db.draft_object(&a.id, "other").is_err());
        assert!(db.draft_object(&a.id, "plan").unwrap()["value"].is_null());
        let reviewed = db.draft_snapshot(&a.id).unwrap();
        let local = serde_json::json!({"text":"local replacement", "references":serde_json::from_str::<Value>(refs).unwrap(), "attachments":serde_json::from_str::<Value>(media).unwrap(), "mode":"queue"});
        peer.save_draft(&a.id, "changed after review").unwrap();
        assert!(db
            .replace_draft_checked(&a.id, &local, &reviewed["revisions"])
            .unwrap_err()
            .contains("DRAFT_CONFLICT"));
        assert_eq!(db.draft(&a.id).unwrap(), "changed after review");
        assert_eq!(db.draft_part(&a.id, "attachments").unwrap(), media);
        let latest = db.draft_snapshot(&a.id).unwrap();
        let updated = db
            .replace_draft_checked(&a.id, &local, &latest["revisions"])
            .unwrap();
        assert_eq!(
            updated["text"].as_i64().unwrap(),
            latest["revisions"]["text"].as_i64().unwrap() + 1
        );
        assert_eq!(db.draft(&a.id).unwrap(), "local replacement");
        assert_eq!(db.draft_part(&a.id, "references").unwrap(), refs);
        assert_eq!(
            serde_json::from_str::<Value>(&db.draft_part(&a.id, "attachments").unwrap()).unwrap(),
            serde_json::from_str::<Value>(media).unwrap()
        );
        drop(peer);
        db.save_draft_mode(&a.id, "btw").unwrap();
        assert_eq!(db.draft_mode(&a.id).unwrap(), "btw");
        assert_eq!(db.draft_part(&a.id, "references").unwrap(), refs);
        assert_eq!(
            serde_json::from_str::<Value>(&db.draft_part(&a.id, "attachments").unwrap()).unwrap(),
            serde_json::from_str::<Value>(media).unwrap()
        );
        assert_eq!(db.draft_part(&b.id, "attachments").unwrap(), "[]");
        db.save_draft_part(&a.id, "attachments", "[]").unwrap();
        assert_eq!(db.draft_part(&a.id, "attachments").unwrap(), "[]");
        db.save_draft(&a.id, "").unwrap();
        assert_eq!(db.draft(&a.id).unwrap(), "");
        assert_eq!(db.draft(&b.id).unwrap(), "second project draft");
        db.recover().unwrap();
        assert!(db
            .sessions()
            .unwrap()
            .iter()
            .all(|s| s.status == "interrupted"));
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
