# Deployment and operations

Status: proposed. Paths, units, images, and commands in this document do not exist yet.

## 1. Artifacts

| Artifact | Platforms | Contents |
|---|---|---|
| `wrongmaild` | Linux x86_64/aarch64 (static musl), Windows x86_64, macOS arm64 | Server + operator CLI |
| `wrongmail` | Linux x86_64/aarch64, Windows x86_64/arm64, macOS arm64/x86_64 | Client CLI, MCP bridge, hook helper |
| Container image `wrongmaild` | linux/amd64, linux/arm64 | Distroless/static base, non-root UID, `/data` volume |
| Checksums + signatures | All | SHA-256 manifest and signature per release |

Bundled SQLite (`rusqlite` `bundled` feature) avoids host library drift. Release builds record the SQLite version in `wrongmaild --version`.

## 2. Linux server (D3 recipe)

### 2.1 Host preparation

```bash
sudo useradd --system --home /var/lib/wrongmail --shell /usr/sbin/nologin wrongmail
sudo install -d -o wrongmail -g wrongmail -m 0700 /var/lib/wrongmail
sudo install -d -o root -g wrongmail -m 0750 /etc/wrongmail
sudo install -m 0755 wrongmaild /usr/local/bin/wrongmaild
sudo -u wrongmail wrongmaild admin init --data-dir /var/lib/wrongmail
#   → prints the first operator credential ONCE; store it in your password manager
```

### 2.2 Configuration `/etc/wrongmail/server.toml` (no secrets)

```toml
data_dir = "/var/lib/wrongmail"

[listen]
address = "127.0.0.1:7463"          # behind reverse proxy
# tls_cert = "/etc/wrongmail/tls/fullchain.pem"   # only for built-in TLS
# tls_key  = "/var/lib/wrongmail/secrets/tls.key"

[proxy]
trusted = ["127.0.0.1/32", "::1/128"]
public_url = "https://mail.example.net"

[limits]
message_body_kib = 64
sends_per_minute = 60

[retention]
default_profile = "standard"        # or "keep-history"

[security]
secret_scan = "reject"              # or "redact"
allowed_mcp_origins = []

[log]
format = "json"
level = "info"
```

### 2.3 systemd unit

```ini
[Unit]
Description=WrongMail agent mail server
After=network-online.target
Wants=network-online.target

[Service]
User=wrongmail
Group=wrongmail
ExecStart=/usr/local/bin/wrongmaild serve --config /etc/wrongmail/server.toml
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/wrongmail
CapabilityBoundingSet=
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Graceful stop: `SIGTERM` stops accepting requests, closes watch streams with a `server_restarting` event, drains writer queues (max 10 s), checkpoints WAL, and exits.

### 2.4 Reverse proxy (default TLS)

Caddy example:

```caddyfile
mail.example.net {
    encode zstd gzip
    reverse_proxy 127.0.0.1:7463 {
        flush_interval -1          # do not buffer SSE
        transport http {
            read_timeout 75s       # > long-poll max
        }
    }
}
```

nginx equivalent must set `proxy_buffering off` for `/v1/projects/*/events` and `/mcp`, and `proxy_read_timeout` above the long-poll maximum.

### 2.5 Network exposure

- Firewall: allow 443 only; the server port stays on loopback.
- Optional: restrict 443 to VPN ranges (D2) or put the host behind WireGuard/Tailscale and skip public DNS.
- Optional mutual TLS at the proxy for an extra factor.

### 2.6 Container

```bash
docker run -d --name wrongmail \
  -v wrongmail-data:/data -v /etc/wrongmail/server.toml:/config/server.toml:ro \
  -p 127.0.0.1:7463:7463 --read-only --user 65532:65532 \
  ghcr.io/<owner>/wrongmaild:<version> serve --config /config/server.toml
```

The volume must be a local filesystem. Network filesystems (NFS/SMB) are refused at startup when detectable, because SQLite WAL locking is unreliable on them.

## 3. Local mode (D1)

- Linux: `systemd --user` unit with the same `ExecStart`, data under `~/.local/share/wrongmail`.
- macOS: LaunchAgent plist with `KeepAlive`.
- Windows: per-user scheduled task at logon, or `wrongmaild service install --user` (planned) creating a background process without a console window; data under `%LOCALAPPDATA%\WrongMail`.
- Listener: `127.0.0.1:7463` or a Unix socket / named pipe; still token-authenticated (other local users and browser pages must not reach it unauthenticated).
- `wrongmaild admin init --local-quickstart` (planned) creates the data dir, one project for the current repository, and an enrolled principal for the current user, printing setup commands for detected tools without writing any tool config.

## 4. Onboarding a project and agents

```bash
# operator (on the server, or remotely with an operator credential)
wrongmaild admin project create wrongstack --display "WrongStack"
wrongmaild admin project link-rule add wrongstack --git-remote github.com/<owner>/wrongstack
wrongmaild admin enroll create --label "laptop / claude-code" --project wrongstack \
    --caps read,watch,manage --agent-pattern "claude-code*" --ttl 24h

# developer machine
wrongmail enroll https://mail.example.net --code <one-time code>
cd /path/to/wrongstack && wrongmail link
wrongmail setup claude-code --scope project --dry-run   # review, then --write
wrongmail doctor
```

Repeat enrollment per tool installation so each has its own principal, revocable independently.

## 5. Backup and restore

- `wrongmaild admin backup` uses the SQLite online backup API per database into `backups/<timestamp>/` with a manifest (schema versions, row counts, SHA-256). Safe while serving.
- Schedule: a systemd timer daily, keep 14; copy off-host (restic/borg/rclone) with encryption.
- The pepper (`secrets/pepper`) is backed up separately and only to encrypted storage; without it, credentials in a restored registry cannot be verified and must be re-enrolled.
- `wrongmaild admin restore <backup>` requires the server stopped, verifies checksums, keeps the replaced data directory as `data.replaced-<timestamp>`.
- Restore drill is part of release validation.

## 6. Upgrades

1. Read release notes for schema and `min_client_version` changes.
2. `wrongmaild admin migrate --dry-run` with the new binary against a backup copy.
3. Replace the binary, restart; migration runs after an automatic pre-migrate backup.
4. Clients older than `min_client_version` receive `426` and `wrongmail doctor` explains how to upgrade.
5. Rollback: stop, reinstall previous binary, restore the pre-migrate backup.

## 7. Observability

| Surface | Contents |
|---|---|
| Logs (stdout/journald) | JSON: request ID, route, status, latency, principal/credential ID, project ID; never bodies or tokens |
| `/v1/admin/metrics` (operator auth) | Prometheus text: requests by route/status, latency histograms, sends by type, active sessions, online agents, watch streams, writer queue depth, SQLite busy/retry counts, secret-scan rejects, rate-limit hits, auth failures |
| `wrongmaild doctor` | Config, permissions, pepper, schema, WAL size, disk space, listener, TLS expiry |
| `wrongmail doctor` | DNS, TLS, clock skew (> 2 min warns), credential validity, grants, link resolution, version |
| `GET /v1/server` | Version, profile, limits (principal auth) |

Suggested alerts: auth failures spike, writer queue depth > 80% for 1 minute, disk < 10%, TLS expiry < 14 days, backup age > 36 hours.

## 8. Incident runbook

| Incident | Action |
|---|---|
| Principal token leaked (committed, pasted) | `wrongmaild admin principal revoke <id>`; re-enroll the installation; review `audit` for that credential ID's activity |
| Operator token leaked | Revoke via another operator credential or offline `wrongmaild admin operator rotate --data-dir` with the server stopped |
| Agent loop flooding a project | Rate limits engage automatically; `admin sessions close <id>`; reduce grant `sends_per_minute`; inspect thread |
| Secret sent despite scanner | Operator hard-deletes the message (`admin message purge <id>`, audited), rotate the exposed secret at its source, add a scanner rule fixture |
| Disk full | Server switches projects to `read_only_maintenance` (reads allowed, sends `503`); free space; run retention |
| Database corruption detected (`integrity_check` fails) | Project goes read-only; restore that project file from backup; other projects unaffected |
| Clock skew on server | Fix NTP; `seq` ordering is unaffected, TTLs may fire early/late |
| Proxy buffering breaks watch | Clients fall back to long-poll automatically; fix proxy flags |

## 9. Capacity planning (targets, NOT measured)

Single small VM (2 vCPU, 2 GiB RAM, SSD): 50 projects, 200 concurrent sessions, 50 sends/second sustained, p95 send latency < 50 ms server-side, watch notification p95 < 500 ms after commit, idle memory < 64 MiB. These are acceptance targets for [Validation](validation.md#6-performance); no measurement exists.
