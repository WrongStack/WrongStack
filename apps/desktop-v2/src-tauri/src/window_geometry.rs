//! Remembered window placement for the main and project windows. Pure data and file handling,
//! so it is testable without a windowing system; the desktop runtime applies it.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

const FILE: &str = "window-geometry.json";
/// Project windows are remembered per project; the oldest are forgotten past this count.
const MAX_ENTRIES: usize = 64;
/// How much of the window's top-left area must lie on a monitor before it is restored there.
const VISIBLE_SPAN: f64 = 120.0;
pub const MIN_WIDTH: f64 = 800.0;
pub const MIN_HEIGHT: f64 = 600.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    /// Logical (DPI-independent) outer position and inner size.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    pub updated_at: i64,
}

/// A monitor's logical work area.
#[derive(Clone, Copy, Debug)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The remembered key for a window label: the main window and per-project windows only.
pub fn key(label: &str) -> Option<String> {
    if label == "main" {
        return Some(label.into());
    }
    let id = label.strip_prefix("project-")?;
    uuid::Uuid::parse_str(id).ok()?;
    Some(label.into())
}

/// Saved placements; a missing, unreadable or foreign file is treated as empty.
pub fn load(dir: &Path) -> HashMap<String, Geometry> {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, Geometry>>(&bytes).ok())
        .map(|map| map.into_iter().filter(|(_, g)| sane(g)).collect())
        .unwrap_or_default()
}

/// Writes atomically (temporary file, then rename) and keeps only the newest entries.
pub fn save(dir: &Path, map: &HashMap<String, Geometry>) -> std::io::Result<()> {
    let mut entries: Vec<_> = map.iter().filter(|(_, g)| sane(g)).collect();
    entries.sort_by(|a, b| b.1.updated_at.cmp(&a.1.updated_at).then(a.0.cmp(b.0)));
    let kept: HashMap<_, _> = entries
        .into_iter()
        .take(MAX_ENTRIES)
        .map(|(k, g)| (k.clone(), *g))
        .collect();
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!("{FILE}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec_pretty(&kept)?)?;
    std::fs::rename(&temp, dir.join(FILE)).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

fn sane(g: &Geometry) -> bool {
    [g.x, g.y, g.width, g.height].iter().all(|v| v.is_finite())
        && g.width >= 1.0
        && g.height >= 1.0
        && g.width <= 100_000.0
        && g.height <= 100_000.0
}

/// The placement to restore, or None when its title area would be off every current monitor
/// (a disconnected display), so the window opens at its default place instead. Sizes below the
/// window minimum are raised to it.
pub fn restorable(g: &Geometry, monitors: &[Area]) -> Option<Geometry> {
    if !sane(g) {
        return None;
    }
    let span = VISIBLE_SPAN.min(g.width);
    let on_screen = monitors.iter().any(|m| {
        let overlap = (g.x + g.width).min(m.x + m.width) - g.x.max(m.x);
        // A maximized window's frame sits a few pixels above the work area.
        overlap >= span && g.y >= m.y - 16.0 && g.y < m.y + m.height - 40.0_f64.min(m.height)
    });
    on_screen.then(|| Geometry {
        width: g.width.max(MIN_WIDTH),
        height: g.height.max(MIN_HEIGHT),
        ..*g
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: f64, y: f64) -> Geometry {
        Geometry {
            x,
            y,
            width: 1200.0,
            height: 800.0,
            maximized: false,
            updated_at: 1,
        }
    }
    const SCREEN: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };

    #[test]
    fn keys_only_main_and_project_windows() {
        assert_eq!(key("main").as_deref(), Some("main"));
        let id = uuid::Uuid::new_v4();
        assert_eq!(key(&format!("project-{id}")), Some(format!("project-{id}")));
        assert_eq!(key("project-not-a-uuid"), None);
        assert_eq!(key(&format!("preview-{id}")), None);
    }

    #[test]
    fn restores_only_where_a_monitor_still_shows_the_title_area() {
        assert_eq!(
            restorable(&at(100.0, 50.0), &[SCREEN]),
            Some(at(100.0, 50.0))
        );
        // A window left on a second display that is gone now opens at its default place.
        assert_eq!(restorable(&at(2500.0, 100.0), &[SCREEN]), None);
        assert_eq!(restorable(&at(100.0, -400.0), &[SCREEN]), None);
        let second = Area {
            x: 1920.0,
            ..SCREEN
        };
        assert!(restorable(&at(2500.0, 100.0), &[SCREEN, second]).is_some());
        // Mostly off the left edge, but the title area still shows.
        assert!(restorable(&at(-1000.0, 100.0), &[SCREEN]).is_some());
        assert_eq!(restorable(&at(-1150.0, 100.0), &[SCREEN]), None);
        assert_eq!(restorable(&at(100.0, 50.0), &[]), None);
    }

    #[test]
    fn raises_tiny_sizes_and_refuses_corrupt_values() {
        let small = Geometry {
            width: 300.0,
            height: 200.0,
            ..at(10.0, 10.0)
        };
        let restored = restorable(&small, &[SCREEN]).unwrap();
        assert_eq!((restored.width, restored.height), (MIN_WIDTH, MIN_HEIGHT));
        let broken = Geometry {
            x: f64::NAN,
            ..at(0.0, 0.0)
        };
        assert_eq!(restorable(&broken, &[SCREEN]), None);
    }

    #[test]
    fn saves_atomically_keeps_the_newest_and_tolerates_bad_files() {
        let dir = std::env::temp_dir().join(format!("ws-geometry-{}", uuid::Uuid::new_v4()));
        assert!(load(&dir).is_empty());
        let mut map = HashMap::new();
        for index in 0..(MAX_ENTRIES + 5) {
            let id = uuid::Uuid::new_v4();
            map.insert(
                format!("project-{id}"),
                Geometry {
                    updated_at: index as i64,
                    ..at(index as f64, 0.0)
                },
            );
        }
        map.insert(
            "main".into(),
            Geometry {
                updated_at: 1_000,
                maximized: true,
                ..at(5.0, 6.0)
            },
        );
        save(&dir, &map).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.len(), MAX_ENTRIES);
        assert!(loaded["main"].maximized);
        assert!(loaded
            .values()
            .all(|g| g.updated_at >= 6 || g.updated_at == 1_000));
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
        std::fs::write(dir.join(FILE), b"{not json").unwrap();
        assert!(load(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
