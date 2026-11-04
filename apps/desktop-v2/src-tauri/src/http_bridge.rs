//! Backend API access stays inside the native host; the renderer selects resources, never origins.
use crate::{err, Result};
use reqwest::{blocking::Client, Method, Url};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};

pub struct EngineHttp {
    port: u16,
    token: String,
    client: Client,
}
/// Searches that take no session selector: they always apply the non-session visibility policy
/// and refuse a selector they cannot honour, so the bridge does not add one.
const SESSIONLESS_PATHS: [&str; 2] = ["/api/memory/search-page", "/api/vector-memory/search"];

impl EngineHttp {
    pub fn new(port: u16, token: &str) -> Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "Cannot initialize the engine API client")?;
        Ok(Self {
            port,
            token: token.into(),
            client,
        })
    }
    /// Sends one engine feature API request as the selected native session.
    pub fn request(
        &self,
        method: &str,
        resource: &str,
        body: &Value,
        session: &str,
        operation_id: Option<&str>,
    ) -> Result<Value> {
        if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method) {
            return Err("Unsupported engine API method".into());
        }
        if !resource.starts_with('/')
            || resource.contains(['#', '\\'])
            || resource.chars().any(char::is_control)
        {
            return Err("Invalid engine API resource".into());
        }
        let mut url = Url::parse(&format!("http://127.0.0.1:{}{resource}", self.port))
            .map_err(|_| "Invalid engine API resource")?;
        if !(url.path().starts_with("/api/")
            || ["/debug/system", "/debug/watcher-metrics"].contains(&url.path()))
        {
            return Err("Resource is not an engine feature API".into());
        }
        // The selected native session owns project resolution. A caller cannot replace it.
        let query: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| key != "sessionId" && key != "token")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let sessionless = SESSIONLESS_PATHS.contains(&url.path());
        url.set_query(None);
        let mut pairs = url.query_pairs_mut();
        pairs.extend_pairs(query);
        if !sessionless {
            pairs.append_pair("sessionId", session);
        }
        drop(pairs);
        let mut request = self
            .client
            .request(Method::from_bytes(method.as_bytes()).map_err(err)?, url)
            .header("x-ws-token", &self.token)
            .header("accept", "application/json");
        let path = resource.split('?').next().unwrap_or_default();
        if let Some(deadline) = server_deadline(method, path) {
            request = request.timeout(deadline);
        }
        if !body.is_null() {
            if serde_json::to_vec(body).map_err(err)?.len() > 128 * 1024 {
                return Err("Engine API request exceeds 128 KiB".into());
            }
            request = request.json(body);
        }
        if let Some(id) = operation_id {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
            {
                return Err("Invalid operation id".into());
            }
            request = request.header("idempotency-key", id);
        }
        let response = request
            .send()
            .map_err(|_| "Engine API request failed or timed out")?;
        let status = response.status().as_u16();
        let markdown_report = method == "GET"
            && path.starts_with("/api/techstack/reports/")
            && response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value.split(';').next().unwrap_or_default().trim() == "text/markdown"
                });
        let mut bytes = Vec::new();
        response
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read engine API response")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("Engine API response exceeds 2 MiB; narrow the query".into());
        }
        let data = if bytes.is_empty() {
            Value::Null
        } else if markdown_report {
            Value::String(String::from_utf8(bytes).map_err(|_| "Engine report is not UTF-8")?)
        } else {
            serde_json::from_slice(&bytes).map_err(|_| "Engine API returned non-JSON data")?
        };
        Ok(json!({"status":status,"ok":(200..300).contains(&status),"data":data}))
    }
}

/// Requests whose server deadline is longer than the default 30 seconds keep that deadline,
/// rather than abandoning an accepted request the engine is still completing.
fn server_deadline(method: &str, path: &str) -> Option<Duration> {
    if method != "POST" {
        return None;
    }
    // Single-dependency research has a canonical 60-second server deadline.
    if path.starts_with("/api/techstack/deps/") && path.ends_with("/research") {
        return Some(Duration::from_secs(75));
    }
    if ["/api/deadcode/scan", "/api/deadcode/preview"].contains(&path) {
        return Some(Duration::from_secs(300));
    }
    if path == "/api/deadcode/apply" {
        // Verification can run several workspace typechecks (10 minutes each).
        return Some(Duration::from_secs(3600));
    }
    // Pull-request operations call GitHub under a two-minute deadline, and publication waits
    // for the PR view to show an updated head; a retry of the same plan is idempotent.
    if let Some(rest) = path.strip_prefix("/api/automation/runs/") {
        if let Some((_, operation)) = rest.split_once("/pr/") {
            if ["prepare", "publish", "check", "follow-up"].contains(&operation) {
                return Some(Duration::from_secs(150));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    #[test]
    fn authenticates_scopes_and_returns_json_without_disclosing_transport_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0 && bytes.len() < 16384);
                bytes.extend_from_slice(&chunk[..count]);
            }
            let input = String::from_utf8_lossy(&bytes).to_lowercase();
            assert!(input.contains("x-ws-token: native-fixture-token"));
            assert!(!input.contains("authorization:"));
            assert!(input.contains("sessionid=core-selected"));
            assert!(!input.contains("sessionid=other"));
            assert!(!input.contains("token=caller"));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"jobs\":[]}").unwrap();
        });
        let bridge = EngineHttp::new(port, "native-fixture-token").unwrap();
        let value = bridge
            .request(
                "GET",
                "/api/automation/state?sessionId=other&token=caller",
                &Value::Null,
                "core-selected",
                None,
            )
            .unwrap();
        assert_eq!(value["data"]["jobs"], json!([]));
        assert!(!value.to_string().contains("native-fixture-token"));
        assert!(!value.to_string().contains("127.0.0.1"));
        server.join().unwrap();
    }
    #[test]
    fn adds_no_session_selector_to_searches_that_refuse_one() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0 && bytes.len() < 16384);
                bytes.extend_from_slice(&chunk[..count]);
            }
            let input = String::from_utf8_lossy(&bytes).to_lowercase();
            assert!(input.starts_with("get /api/memory/search-page?q=vault "));
            assert!(!input.contains("sessionid="));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        });
        let bridge = EngineHttp::new(port, "native-fixture-token").unwrap();
        bridge
            .request(
                "GET",
                "/api/memory/search-page?q=vault&sessionId=other",
                &Value::Null,
                "core-selected",
                None,
            )
            .unwrap();
        server.join().unwrap();
    }
    #[test]
    fn does_not_follow_api_redirects_or_forward_private_credentials_to_another_origin() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/leak\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        });
        let value = EngineHttp::new(port, "private-fixture")
            .unwrap()
            .request("GET", "/api/redirect", &Value::Null, "selected", None)
            .unwrap();
        assert_eq!(value["status"], 302);
        assert_eq!(value["ok"], false);
        assert!(!value.to_string().contains("private-fixture"));
        server.join().unwrap();
    }
    #[test]
    fn bounds_api_response_bodies_before_they_enter_native_ipc() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).unwrap();
            let body = vec![b' '; 2 * 1024 * 1024 + 64];
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).unwrap();
            let _ = socket.write_all(&body);
        });
        let result = EngineHttp::new(port, "fixture").unwrap().request(
            "GET",
            "/api/large",
            &Value::Null,
            "selected",
            None,
        );
        assert!(result.unwrap_err().contains("2 MiB"));
        server.join().unwrap();
    }
    #[test]
    fn refuses_origins_static_pages_traversal_and_unsupported_methods_before_network_access() {
        let bridge = EngineHttp::new(1, "fixture").unwrap();
        for path in [
            "https://example.com/api/jobs",
            "//example.com/api/jobs",
            "/index.html",
            "/api/../../index.html",
            "/api/jobs#fragment",
        ] {
            assert!(bridge
                .request("GET", path, &Value::Null, "selected", None)
                .is_err());
        }
        assert!(bridge
            .request("CONNECT", "/api/jobs", &Value::Null, "selected", None)
            .is_err());
    }
    #[test]
    fn keeps_server_deadlines_longer_than_the_default_timeout() {
        let run = "/api/automation/runs/7e16130e-4876-4251-8629-7b7cfad7db35";
        for operation in ["prepare", "publish", "check", "follow-up"] {
            assert_eq!(
                server_deadline("POST", &format!("{run}/pr/{operation}")),
                Some(Duration::from_secs(150))
            );
        }
        assert_eq!(server_deadline("GET", &format!("{run}/pr")), None);
        assert_eq!(server_deadline("POST", &format!("{run}/cancel")), None);
        assert_eq!(server_deadline("POST", &format!("{run}/pr/other")), None);
        assert_eq!(
            server_deadline("POST", "/api/techstack/deps/react/research"),
            Some(Duration::from_secs(75))
        );
        assert_eq!(
            server_deadline("POST", "/api/deadcode/apply"),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(server_deadline("POST", "/api/automation/state"), None);
    }
    #[test]
    fn reads_markdown_only_for_the_report_api_and_keeps_json_validation_elsewhere() {
        for (path, allowed) in [
            ("/api/techstack/reports/fixture?format=md", true),
            ("/api/other", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request).unwrap();
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/markdown; charset=utf-8\r\nContent-Length: 8\r\nConnection: close\r\n\r\n# Report").unwrap();
            });
            let result = EngineHttp::new(port, "fixture").unwrap().request(
                "GET",
                path,
                &Value::Null,
                "selected",
                None,
            );
            if allowed {
                assert_eq!(result.unwrap()["data"], "# Report");
            } else {
                assert!(result.unwrap_err().contains("non-JSON"));
            }
            server.join().unwrap();
        }
    }
}
