//! Desktop-only project membership and ordering. The host registry and project files stay intact;
//! adding a removed folder restores its existing conversations, even with an older session host.
use crate::{err, registry::Project, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

const KEY: &str = "desktop-project-menu";
#[derive(Default, Serialize, Deserialize)]
struct Menu {
    order: Vec<String>,
    hidden: Vec<String>,
}
fn open(dir: &Path) -> Result<Connection> {
    let db = Connection::open(dir.join("workspace.sqlite")).map_err(err)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(err)?;
    Ok(db)
}
fn load(db: &Connection) -> Result<Menu> {
    let value: Option<String> = db
        .query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?;
    value
        .map(|v| serde_json::from_str(&v).map_err(err))
        .unwrap_or_else(|| Ok(Menu::default()))
}
fn update(dir: &Path, action: impl FnOnce(&mut Menu) -> Result<()>) -> Result<()> {
    let mut db = open(dir)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut menu = load(&tx)?;
    action(&mut menu)?;
    tx.execute(
        "INSERT INTO settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [KEY, &serde_json::to_string(&menu).map_err(err)?],
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}
fn projects(snapshot: &Value) -> Result<Vec<Project>> {
    serde_json::from_value(snapshot["projects"].clone()).map_err(err)
}
fn root<'a>(projects: &'a [Project], id: &str) -> Result<&'a str> {
    projects
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.root.as_str())
        .ok_or_else(|| "Unknown project".into())
}
fn ordered(menu: &Menu, projects: &[Project]) -> Vec<String> {
    let mut roots: Vec<String> = projects
        .iter()
        .filter(|p| !menu.hidden.contains(&p.root))
        .map(|p| p.root.clone())
        .collect();
    roots.sort_by_key(|root| {
        menu.order
            .iter()
            .position(|saved| saved == root)
            .unwrap_or(usize::MAX)
    });
    roots
}
/// Decorates the host snapshot without changing its registry, drafts, or transcripts.
pub fn snapshot(dir: &Path, mut snapshot: Value) -> Result<Value> {
    let menu = load(&open(dir)?)?;
    let mut projects = projects(&snapshot)?;
    let order = ordered(&menu, &projects);
    projects.retain(|p| !menu.hidden.contains(&p.root));
    projects.sort_by_key(|p| order.iter().position(|root| root == &p.root));
    if let Some(sessions) = snapshot["sessions"].as_array_mut() {
        sessions.retain(|s| projects.iter().any(|p| s["projectId"] == p.id));
    }
    snapshot["projects"] = serde_json::to_value(projects).map_err(err)?;
    Ok(snapshot)
}
/// Re-registering a folder restores it at the end, using its original project identity.
pub fn restore(dir: &Path, project: &Value, snapshot: &Value) -> Result<()> {
    let project: Project = serde_json::from_value(project.clone()).map_err(err)?;
    let projects = projects(snapshot)?;
    update(dir, |menu| {
        menu.order = ordered(menu, &projects);
        menu.hidden.retain(|root| root != &project.root);
        if !menu.order.contains(&project.root) {
            menu.order.push(project.root);
        }
        Ok(())
    })
}
/// Runs at the trusted shell boundary, not the service-host project router. It works with
/// an already-running older host and never starts project/profile engines for menu actions.
pub fn request(
    dir: &Path,
    method: &str,
    params: &Value,
    call: impl Fn(&str, Value) -> Result<Value>,
) -> Result<Value> {
    match method {
        "snapshot" => snapshot(dir, call("snapshot", params.clone())?),
        "project.register" => {
            let project = call(method, params.clone())?;
            restore(dir, &project, &call("snapshot", serde_json::json!({}))?)?;
            Ok(project)
        }
        "project-menu.remove" | "project-menu.move" => {
            let id = crate::sessions::field(params, "id")?;
            let current = call("snapshot", serde_json::json!({}))?;
            if method == "project-menu.remove" {
                remove(dir, &current, id)?;
            } else {
                let after = params["after"].as_bool().ok_or("Missing move direction")?;
                move_project(
                    dir,
                    &current,
                    id,
                    crate::sessions::field(params, "target")?,
                    after,
                )?;
            }
            Ok(Value::Null)
        }
        _ => Err("Unknown project menu method".into()),
    }
}
pub fn remove(dir: &Path, snapshot: &Value, id: &str) -> Result<()> {
    let projects = projects(snapshot)?;
    let root = root(&projects, id)?;
    update(dir, |menu| {
        if !menu.hidden.iter().any(|saved| saved == root) {
            menu.hidden.push(root.to_owned());
        }
        menu.order.retain(|saved| saved != root);
        Ok(())
    })
}
/// Relative moves preserve projects added by another window; never replace a stale full list.
pub fn move_project(
    dir: &Path,
    snapshot: &Value,
    id: &str,
    target: &str,
    after: bool,
) -> Result<()> {
    let projects = projects(snapshot)?;
    let source = root(&projects, id)?;
    let target = root(&projects, target)?;
    update(dir, |menu| {
        if menu
            .hidden
            .iter()
            .any(|root| root == source || root == target)
        {
            return Err("Project is no longer in the menu".into());
        }
        if source == target {
            return Ok(());
        }
        let mut order = ordered(menu, &projects);
        order.retain(|root| root != source);
        let index = order
            .iter()
            .position(|root| root == target)
            .ok_or("Unknown target project")?;
        order.insert(index + usize::from(after), source.to_owned());
        menu.order = order;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Registry;
    use serde_json::json;
    struct Fixture {
        dir: std::path::PathBuf,
        snapshot: Value,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("desktop-menu-{}", uuid::Uuid::new_v4()));
            let db = Registry::open(&dir).unwrap();
            let projects: Vec<Project> = ["a", "b", "c"]
                .iter()
                .map(|name| {
                    let root = dir.join(name);
                    std::fs::create_dir(&root).unwrap();
                    std::fs::write(root.join("keep.txt"), "keep").unwrap();
                    db.register(root.to_str().unwrap()).unwrap()
                })
                .collect();
            let session = crate::registry::Session {
                id: uuid::Uuid::new_v4().to_string(),
                project_id: projects[0].id.clone(),
                title: "Kept conversation".into(),
                kind: "agent".into(),
                workdir: projects[0].root.clone(),
                status: "running".into(),
                created_at: 1,
                updated_at: 1,
                exit_code: None,
                error: None,
                untitled: false,
            };
            db.insert(&session).unwrap();
            db.save_draft(&session.id, "Kept draft").unwrap();
            let snapshot =
                json!({"sessions":db.sessions().unwrap(),"projects":projects,"layout":null});
            Self { dir, snapshot }
        }
        fn id(&self, i: usize) -> &str {
            self.snapshot["projects"][i]["id"].as_str().unwrap()
        }
        fn names(&self) -> Vec<String> {
            projects(&snapshot(&self.dir, self.snapshot.clone()).unwrap())
                .unwrap()
                .into_iter()
                .map(|p| p.name)
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).unwrap();
        }
    }
    #[test]
    fn moves_both_directions_and_persists_without_touching_other_settings() {
        let f = Fixture::new();
        assert_eq!(f.names(), ["a", "b", "c"]);
        move_project(&f.dir, &f.snapshot, f.id(2), f.id(0), false).unwrap();
        assert_eq!(f.names(), ["c", "a", "b"]);
        move_project(&f.dir, &f.snapshot, f.id(2), f.id(1), true).unwrap();
        assert_eq!(f.names(), ["a", "b", "c"]);
        move_project(&f.dir, &f.snapshot, f.id(1), f.id(1), false).unwrap();
        assert_eq!(f.names(), ["a", "b", "c"]);
        assert_eq!(
            Registry::open(&f.dir).unwrap().setting("layout").unwrap(),
            None
        );
    }
    #[test]
    fn removal_preserves_files_registry_and_sessions_and_can_be_restored() {
        let f = Fixture::new();
        remove(&f.dir, &f.snapshot, f.id(0)).unwrap();
        assert_eq!(f.names(), ["b", "c"]);
        assert!(snapshot(&f.dir, f.snapshot.clone()).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(Registry::open(&f.dir).unwrap().projects().unwrap().len(), 3);
        assert_eq!(
            std::fs::read_to_string(f.dir.join("a/keep.txt")).unwrap(),
            "keep"
        );
        restore(&f.dir, &f.snapshot["projects"][0], &f.snapshot).unwrap();
        assert!(f.names().contains(&"a".to_owned()));
        assert_eq!(
            snapshot(&f.dir, f.snapshot.clone()).unwrap()["sessions"][0]["id"],
            f.snapshot["sessions"][0]["id"]
        );
        let registry = Registry::open(&f.dir).unwrap();
        let sessions = registry.sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, "running");
        assert_eq!(registry.draft(&sessions[0].id).unwrap(), "Kept draft");
    }
    #[test]
    fn shell_boundary_registers_restores_and_validates_requests_without_starting_engines() {
        let f = Fixture::new();
        let call = |method: &str, params: Value| match method {
            "snapshot" => Ok(f.snapshot.clone()),
            "project.register" => Ok(serde_json::to_value(
                Registry::open(&f.dir)?.register(crate::sessions::field(&params, "root")?)?,
            )
            .map_err(err)?),
            _ => Err(format!("Unexpected host method {method}")),
        };
        request(
            &f.dir,
            "project-menu.move",
            &json!({"id":f.id(2),"target":f.id(0),"after":false}),
            call,
        )
        .unwrap();
        assert_eq!(f.names(), ["c", "a", "b"]);
        request(&f.dir, "project-menu.remove", &json!({"id":f.id(0)}), call).unwrap();
        assert_eq!(f.names(), ["c", "b"]);
        let registered = request(
            &f.dir,
            "project.register",
            &json!({"root":f.dir.join("a")}),
            call,
        )
        .unwrap();
        assert_eq!(registered["id"], f.id(0));
        assert_eq!(f.names(), ["c", "b", "a"]);
        let shown = request(&f.dir, "snapshot", &json!({"layoutKey":"layout"}), call).unwrap();
        assert_eq!(shown["projects"][2]["id"], f.id(0));
        assert!(request(
            &f.dir,
            "project-menu.move",
            &json!({"id":f.id(0),"target":f.id(1)}),
            call
        )
        .is_err());
        assert!(request(&f.dir, "project-menu.remove", &json!({}), call).is_err());
        assert_eq!(f.names(), ["c", "b", "a"]);
    }
    #[test]
    fn invalid_and_stale_moves_fail_without_changing_order() {
        let f = Fixture::new();
        assert!(move_project(&f.dir, &f.snapshot, "unknown", f.id(0), false).is_err());
        assert!(move_project(&f.dir, &f.snapshot, f.id(0), "unknown", false).is_err());
        assert!(remove(&f.dir, &f.snapshot, "unknown").is_err());
        remove(&f.dir, &f.snapshot, f.id(1)).unwrap();
        assert!(move_project(&f.dir, &f.snapshot, f.id(0), f.id(1), true).is_err());
        assert_eq!(f.names(), ["a", "c"]);
    }
}
