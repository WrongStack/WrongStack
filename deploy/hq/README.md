# WrongStack HQ container

This package builds the current checkout into an immutable, non-root HQ image.
Runtime package updates never happen inside the container; replacement is
performed by Compose and accepted only after the image healthcheck succeeds.

## Local/source deployment

```bash
cd deploy/hq
cp .env.example .env
mkdir -p secrets
printf '%s' 'replace-with-a-long-random-password' > secrets/hq_password.txt
chmod 600 secrets/hq_password.txt
docker compose build --pull
docker compose up -d
docker compose ps
```

HQ listens on `0.0.0.0:3499`. Its state and authentication database live in
the `wrongstack_hq_data` volume. The root filesystem is read-only; the process
runs as the image's unprivileged `node` user with all Linux capabilities
dropped.

The mounted password is a first-run bootstrap secret. After initialization,
password changes made in HQ Settings remain authoritative across container
restarts; the unchanged secret file does not overwrite them.

`WRONGSTACK_HQ_ALLOWLIST` accepts comma-separated exact IPv4/IPv6 addresses and
CIDR networks. Leave it empty to admit every source before password auth.
Loopback remains implicit. HQ checks the actual TCP peer and ignores forwarded
headers. Docker bridge/NAT can mask the original peer; in that topology put
end-user filtering on the host firewall or reverse proxy.

## Registry deployment and updates

Set `WRONGSTACK_HQ_IMAGE` in `.env` to an image hosted in your registry, then:

```bash
docker compose pull hq
docker compose up -d hq
```

`update.sh` records the running image ID, pulls the configured tag, recreates
only HQ, waits for Docker health, and retags/recreates the previous image on
failure. Pull failures do not touch the running container.

For the included host-side timer, install this directory at
`/opt/wrongstack-hq`, then install the units:

```bash
sudo cp systemd/wrongstack-hq-container-update.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wrongstack-hq-container-update.timer
```

Run an update immediately with:

```bash
sudo systemctl start wrongstack-hq-container-update.service
journalctl -u wrongstack-hq-container-update.service -n 100 --no-pager
```

Do not enable the timer while `WRONGSTACK_HQ_IMAGE=wrongstack-hq:local`; an
automatic updater needs a remote registry tag. Prefer a controlled release
channel tag, and keep immutable version tags available for manual recovery.
