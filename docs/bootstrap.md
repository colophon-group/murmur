# Hetzner box bootstrap runbook

This runbook brings a fresh Hetzner box up to host Murmur. Source spec: `DESIGN.md` §6.5. Companion docs: deploy script (`scripts/deploy.sh`, issue `colophon-group/murmur#19`), Cloudflare Tunnel setup (issue `colophon-group/murmur#21`).

The runbook is intentionally written to be re-runnable. Every step uses idempotent commands (`mkdir -p`, `id -u deploy >/dev/null 2>&1 || useradd ...`, `grep -q ... || echo ... >> ...`). If step N fails partway, fix it and re-run from step N — earlier steps are no-ops the second time.

> **Audience.** The operator running this once per box. Read top to bottom; do not skip ahead.

---

## 0. Box identity

Fill these placeholders before running anything else, then verify no placeholder leaked through (see [Recovery — placeholder gate](#placeholder-gate) below).

```text
# REPLACE: <box-ipv4>          public IPv4 of the Hetzner box
# REPLACE: <box-ipv6>          public IPv6 of the Hetzner box
# REPLACE: <box-private-ipv4>  private (vSwitch) IPv4, if any; else N/A
# REPLACE: <box-hostname>      e.g. murmur-prod-1
# REPLACE: <volume-id>         Hetzner volume ID for the data disk (HC_Volume_NNNNNNN)
```

These values live in the operator's notes (1Password / handoff doc), not in the repo. After replacing, run:

```bash
grep -n 'REPLACE:' docs/bootstrap.md && echo "FAIL: placeholders remain" || echo "OK: no placeholders"
```

The `&& echo FAIL ... || echo OK` form prints `OK: no placeholders` only when grep exits non-zero (no matches). This is the placeholder gate referenced from the recovery section.

The SSH config block on the operator's local machine (entry `Host murmur ... HostName 178.105.51.62 ...`) lives in `AGENTS.md` lines 67-79; do **not** duplicate it here. Adjust the `HostName` there to match `<box-ipv4>` above.

---

## 1. Provision the server

**Action.** In the Hetzner Cloud console:

- Project: the colophon-group project that owns Murmur
- Location: `hel1` (matches jobseek's box; same region keeps inter-service latency low)
- Image: **Ubuntu 24.04**
- Type: **CAX11** (ARM64, shared vCPU). The `CAX` family is required — `CX` is x86 and will not match the ARM container builds produced by D2.
- SSH key: paste the operator's *personal* public key (used for the initial `root` login only; the `deploy` user gets its own key in step 4)
- Networking: enable IPv6; enable a private network if jobseek's box is on one (matches `<box-private-ipv4>` above)

**Verify.**

```bash
# from the operator's machine, after replacing <box-ipv4>:
ssh -o StrictHostKeyChecking=accept-new root@<box-ipv4> 'uname -m && lsb_release -ds'
# expected: aarch64
#           Ubuntu 24.04 LTS
```

If the architecture is not `aarch64` or the release is not `24.04`, destroy the server and re-provision — do not try to mutate it.

---

## 2. Attach and persist the data volume

The Murmur SQLite DB and any uploaded artifacts live on a dedicated volume so the boot disk stays disposable.

**Action.** In the Hetzner console, create a volume in the same location, attach it to the box, and *do not* check "Automount" (we want explicit control via `/etc/fstab`).

Then on the box (`ssh root@<box-ipv4>`):

```bash
# Identify the volume — Hetzner volumes appear as /dev/sdb (or similar) with a stable
# /dev/disk/by-id/scsi-0HC_Volume_<volume-id> symlink.
ls -l /dev/disk/by-id/ | grep HC_Volume_

# Format only if not already ext4 (idempotent):
DEV=/dev/disk/by-id/scsi-0HC_Volume_<volume-id>   # REPLACE: <volume-id>
if ! blkid "$DEV" | grep -q 'TYPE="ext4"'; then
  mkfs.ext4 -L murmur-data "$DEV"
fi

# Mount point:
mkdir -p /mnt/murmur

# Persist in /etc/fstab — guarded against double-write:
FSTAB_ENTRY="LABEL=murmur-data /mnt/murmur ext4 discard,nofail,defaults 0 0"
grep -q 'LABEL=murmur-data' /etc/fstab || echo "$FSTAB_ENTRY" >> /etc/fstab

# Mount everything declared in fstab (no-op if already mounted):
mount -a
```

The `nofail` flag is intentional: if the volume is detached (e.g., during recovery), the box still boots and we can intervene. `discard` enables TRIM on the underlying SSD.

**Verify.**

```bash
lsblk
# expect to see the volume (e.g., sdb) mounted at /mnt/murmur

cat /etc/fstab | grep murmur
# expect: LABEL=murmur-data /mnt/murmur ext4 discard,nofail,defaults 0 0

mountpoint -q /mnt/murmur && echo "OK: mounted" || echo "FAIL: not mounted"

df -h /mnt/murmur
# expect the volume's full size, not the boot disk's size
```

---

## 3. Install Docker

We use the upstream Docker apt repository (not Ubuntu's `docker.io` package) so we get current `buildx` and Compose v2.

**Action.**

```bash
# Pre-reqs (idempotent — apt-get install is a no-op if already installed):
apt-get update
apt-get install -y ca-certificates curl gnupg

# Docker GPG key (idempotent — overwrite is fine):
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Docker apt source — written via a guarded heredoc so re-running is a no-op:
ARCH=$(dpkg --print-architecture)
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Daemon should be running and enabled across reboots:
systemctl enable --now docker
```

**Verify.**

```bash
docker --version
# expect: Docker version 27.x.x or newer

docker buildx version
# expect: github.com/docker/buildx v0.x.x

docker compose version
# expect: Docker Compose version v2.x.x

docker run --rm --platform linux/arm64 hello-world
# expect: "Hello from Docker!" — confirms ARM64 image execution
```

---

## 4. Create the `deploy` user

The `deploy` user is what GitHub Actions logs in as via the `HETZNER_SSH_KEY` secret (see step 6). It owns `/home/deploy` (where `.env` and `compose.yaml` live) and `/mnt/murmur` (where data lives).

**Action.**

```bash
# Idempotent user creation:
id -u deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy

# Home directory perms:
chmod 700 /home/deploy
chown deploy:deploy /home/deploy

# SSH directory:
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh

# Authorized key — paste the *public* half of the keypair whose private half goes into
# the GH `production` secret HETZNER_SSH_KEY (step 6). The keypair is generated locally
# with: ssh-keygen -t ed25519 -f ~/.ssh/hetzner_deploy -C 'github-actions@murmur'
# Then ~/.ssh/hetzner_deploy.pub goes here (in authorized_keys), and ~/.ssh/hetzner_deploy
# (the private key) becomes the HETZNER_SSH_KEY secret in step 6.
cat > /home/deploy/.ssh/authorized_keys <<'EOF'
# REPLACE: <ssh-ed25519 AAAA... github-actions@murmur>
EOF
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# Docker access for deploy:
usermod -aG docker deploy

# Hand /mnt/murmur to deploy so containers running as deploy can write there:
chown -R deploy:deploy /mnt/murmur
```

**Verify.**

```bash
id deploy
# expect: uid=1001(deploy) gid=1001(deploy) groups=1001(deploy),...,docker

stat -c '%a %U %G' /home/deploy
# expect: 700 deploy deploy

stat -c '%a %U %G' /home/deploy/.ssh
# expect: 700 deploy deploy

stat -c '%a %U %G' /home/deploy/.ssh/authorized_keys
# expect: 600 deploy deploy

# From the operator's local machine, using the matching private key:
ssh -i ~/.ssh/hetzner_deploy deploy@<box-ipv4> 'docker ps && ls -la /mnt/murmur'
# expect: empty docker ps table (no containers yet) + listing of /mnt/murmur
```

If the SSH login fails with "Permission denied (publickey)", recheck `authorized_keys` — most often the placeholder marker on line 1 is still present.

---

## 5. Cloudflare Tunnel

This step depends on the Cloudflare Tunnel artifacts produced by issue `colophon-group/murmur#21` (D4 — `cloudflared` config + tunnel registration). Follow that issue's PR description for the full tunnel setup; the steps below are the box-side install only.

**Action.**

```bash
# Install cloudflared via Cloudflare's apt repo (idempotent):
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared

# Install the tunnel as a system service using the token from the GH `production`
# secret CLOUDFLARE_TUNNEL_TOKEN (set in step 6). The token alone is enough — it
# embeds the tunnel UUID and credentials. Re-running with the same token is a no-op.
TUNNEL_TOKEN='# REPLACE: <cloudflare-tunnel-token>'
cloudflared service install "$TUNNEL_TOKEN"

# The tunnel ingress config (which hostname → which local port) is configured in
# the Cloudflare dashboard during the D4 setup. The runbook for that lives in
# colophon-group/murmur#21. The required ingress is:
#   murmur.colophon-group.org  →  http://localhost:8080
# Do not edit /etc/cloudflared/config.yml on the box; the dashboard config takes
# precedence when a tunnel runs from a token.
```

**Verify.**

```bash
systemctl status cloudflared
# expect: Active: active (running)

# From any machine with `cloudflared` installed and Cloudflare auth (the operator's
# machine, not the box):
cloudflared tunnel info murmur
# expect: tunnel UUID, "1 active connection" or more, connector running on the box

# Smoke test the public hostname (will 502 until step 7's stack is up — that's
# expected; we're confirming DNS + tunnel reach the box, not that the app works):
curl -sS -o /dev/null -w '%{http_code}\n' https://murmur.colophon-group.org/health
# expect: 502 here (tunnel is up, app isn't), 200 after step 7
```

---

## 6. GitHub `production` environment secrets

These secrets are consumed by the deploy workflow built in issue `colophon-group/murmur#19` (D2). Set them under **Settings → Environments → production** on `colophon-group/murmur` (a `production` env, not a repo-level secret — environment secrets gate on the `production` env's protection rules).

| Secret | Source | Used for |
|---|---|---|
| `MURMUR_TOKEN` | random 32-byte hex (`openssl rand -hex 32`) | written into `/home/deploy/.env` as the bearer token Murmur expects on `/pull` and `/submit` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare dashboard → Zero Trust → Tunnels → `murmur` → "Install connector" → "Use a token" | passed to `cloudflared service install` (step 5) |
| `HETZNER_SSH_KEY` | private half of the `hetzner_deploy` keypair (step 4) | GH Actions uses this to `ssh deploy@<box-ipv4>` and run `scripts/deploy.sh` |

**Action.**

```bash
# From the operator's machine, with `gh` authenticated:
gh secret set MURMUR_TOKEN            --env production --repo colophon-group/murmur --body "$(openssl rand -hex 32)"
gh secret set CLOUDFLARE_TUNNEL_TOKEN  --env production --repo colophon-group/murmur < <(printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN_VALUE")
gh secret set HETZNER_SSH_KEY          --env production --repo colophon-group/murmur < ~/.ssh/hetzner_deploy
```

The `< <(printf ...)` and `< ~/.ssh/hetzner_deploy` forms avoid putting secret material on the command line (where it would land in shell history).

**Verify.**

```bash
gh secret list --env production --repo colophon-group/murmur
# expect: MURMUR_TOKEN, CLOUDFLARE_TUNNEL_TOKEN, HETZNER_SSH_KEY (values not shown — that's fine)
```

---

## 7. First deploy

**Action.** Trigger the deploy workflow shipped by issue `colophon-group/murmur#19`. Either push a commit to `main` (the workflow runs on push) or run it manually:

```bash
gh workflow run deploy.yml --repo colophon-group/murmur --ref main
gh run watch --repo colophon-group/murmur
```

The deploy workflow (per `#19`):

1. Builds the multi-arch Murmur image and pushes it.
2. SSHes to `deploy@<box-ipv4>` using `HETZNER_SSH_KEY`.
3. Writes `/home/deploy/.env` with `MURMUR_TOKEN=...` and any other env consumed by `compose.yaml`.
4. `docker compose pull && docker compose up -d`.
5. Health-checks `http://localhost:8080/health` from the box itself before exiting.

**Verify.**

```bash
# On the box:
ssh deploy@<box-ipv4>
ls -la /home/deploy/.env
# expect: -rw------- 1 deploy deploy <size> <date> /home/deploy/.env

docker compose -f /home/deploy/compose.yaml ps
# expect: murmur container, status Up (healthy)

curl -sS http://localhost:8080/health
# expect: 200 OK with whatever health body Murmur returns

exit

# From the operator's machine:
curl -sS https://murmur.colophon-group.org/health
# expect: 200 OK — same body. This is the end-to-end success criterion.
```

If the public URL returns 200 with a healthy body, the box is up.

---

## Recovery — what to do when a step fails

Every step is reversible. Identify which step failed by the verification command that returned the wrong result, then apply the matching recipe.

### Placeholder gate

If `grep -n 'REPLACE:' docs/bootstrap.md` exits 0 (matches found) at *any* point while running this runbook, stop. A placeholder leaked through. Fix the file (or, if you're running from a fork, fix your local copy) and re-run from step 1 — every step is idempotent, so re-running is safe.

The intent of the gate is that an operator who reads "REPLACE:" must consciously substitute it; the gate is the safety net for when they forget.

### Step 1 (provision) failed

The box is in an unknown state. Destroy it from the Hetzner console and re-provision. Do not try to fix a broken provision.

### Step 2 (volume) failed

```bash
# Unmount and clean up:
umount /mnt/murmur 2>/dev/null || true
sed -i.bak '/LABEL=murmur-data/d' /etc/fstab
# /etc/fstab.bak is created — keep it until you confirm the new fstab is correct.
```

If the volume itself was wiped, re-attach a fresh volume from the Hetzner console and re-run step 2. The `mkfs.ext4` in step 2 is guarded by `blkid`, so re-running won't reformat an already-formatted volume; if you specifically need to reformat, run `wipefs -a "$DEV"` first.

### Step 3 (Docker) failed

```bash
# Remove and reinstall:
apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
rm -rf /var/lib/docker /var/lib/containerd
rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.gpg
# Re-run step 3.
```

### Step 4 (deploy user) failed

```bash
# Nuclear option — only if the user is in a broken state:
userdel -r deploy
# Re-run step 4.
```

If you only need to rotate the SSH key, edit `/home/deploy/.ssh/authorized_keys` directly and update the `HETZNER_SSH_KEY` secret (step 6).

### Step 5 (Cloudflare Tunnel) failed

```bash
# Remove the systemd service and re-install:
cloudflared service uninstall || true
systemctl daemon-reload
# Re-run the cloudflared service install step.
```

If the tunnel is registered to the wrong account or the token is wrong, regenerate the token in the Cloudflare dashboard (Zero Trust → Tunnels → `murmur` → "Refresh token"), update `CLOUDFLARE_TUNNEL_TOKEN` in step 6, and re-run step 5.

### Step 6 (GH secrets) failed

Re-run the `gh secret set` commands. They're upserts.

### Step 7 (first deploy) failed

Read the failed run's logs:

```bash
gh run list --repo colophon-group/murmur --workflow deploy.yml --limit 1
gh run view <run-id> --log-failed --repo colophon-group/murmur
```

The deploy workflow (`#19`) writes its own troubleshooting hints. If the failure is at the `docker compose up` stage, ssh to the box and run `docker compose -f /home/deploy/compose.yaml logs --tail=200`. If the failure is at the SSH stage, recheck step 4 (`authorized_keys`) and step 6 (`HETZNER_SSH_KEY`).

### Full rollback

If the box is irrecoverable, destroy it from the Hetzner console. The data volume can be detached first (Hetzner console → Volumes → Detach) and re-attached to a freshly provisioned box at step 2 — the existing ext4 filesystem will be picked up by the `blkid` check and skipped, so the data survives.
