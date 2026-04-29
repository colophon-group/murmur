# Cloudflare Tunnel + DNS runbook (D4)

This runbook brings up the Cloudflare Tunnel that fronts `murmur.colophon-group.org` → `http://localhost:8080` on the Hetzner box. Source spec: `DESIGN.md` §6.1, §6.2. Companion docs: Hetzner box bootstrap (`docs/bootstrap.md`, issue `colophon-group/murmur#20`), deploy script (issue `colophon-group/murmur#19`), compose stack (issue `colophon-group/murmur#18`).

The tunnel pattern matches jobseek's `typesense.colophon-group.org`: no inbound port on the box, no Caddy/TLS to manage, no manual A record. Cloudflare's edge holds the TLS cert; the box runs `cloudflared` which dials *out* to Cloudflare and ferries traffic in over the established connection.

> **Audience.** The operator running this once per Cloudflare account / per box. Read top to bottom; do not skip ahead. Every step is idempotent (re-create-if-missing, upsert-on-set), so if step N fails partway, fix it and re-run from step N — earlier steps are no-ops the second time.

> **Pairing with `docs/bootstrap.md`.** The bootstrap runbook covers the box-side install of `cloudflared` (apt repo, `cloudflared service install <token>`, recovery). This runbook covers the Cloudflare-side setup (tunnel registration in Zero Trust, hostname route, GH secret). Both reference the same `CLOUDFLARE_TUNNEL_TOKEN`. The box-side install in `bootstrap.md` is an alternative to the Docker sidecar described here for the production stack — `DESIGN.md` §6.2 specifies the Docker sidecar (consumed by the compose stack from issue `colophon-group/murmur#18`); the systemd-service path in `bootstrap.md` exists for operators who need the tunnel up before D1's compose stack lands. Pick one path per box and stick to it.

---

## 0. Identity

Fill these placeholders before running anything else, then verify no placeholder leaked through (see [Recovery — placeholder gate](#placeholder-gate) below).

```text
# REPLACE: <box-ipv4>          public IPv4 of the Hetzner box (canonical: see DESIGN.md §6.1)
# REPLACE: <cf-account-id>     Cloudflare account ID that owns colophon-group.org
# REPLACE: <tunnel-uuid>       UUID assigned by Cloudflare when the tunnel is created (step 1)
```

These values live in the operator's notes (1Password / handoff doc), not in the repo. After replacing, run:

```bash
grep -n 'REPLACE:' docs/cloudflare-tunnel.md && echo "FAIL: placeholders remain" || echo "OK: no placeholders"
```

The `&& echo FAIL ... || echo OK` form prints `OK: no placeholders` only when grep exits non-zero (no matches). This is the placeholder gate referenced from the recovery section.

The canonical box IPv4 lives in `DESIGN.md` §6.1 and the SSH config block in `AGENTS.md` lines 67-79; do not duplicate it here.

---

## 1. Create the tunnel in Cloudflare Zero Trust

**Action.** In the Cloudflare dashboard:

1. Open **Zero Trust → Networks → Tunnels**.
2. Click **Create a tunnel**.
3. Select connector type **Cloudflared**.
4. Tunnel name: `murmur` (exact spelling — this is the name `cloudflared tunnel info murmur` will look up later, and it shows up in dashboard breadcrumbs).
5. Click **Save tunnel**. Cloudflare assigns a UUID — record it as `<tunnel-uuid>` in step 0's identity block.
6. The next screen shows the install snippet for several platforms. Switch to the **Docker** tab and copy the value of the `--token` flag (a long base64 blob beginning with `ey...`). This is the `CLOUDFLARE_TUNNEL_TOKEN` consumed by step 3 below and by the cloudflared sidecar in compose. **Do not paste the full `docker run` line** — only the token value, and only into the GH secret step. The token is bearer-equivalent: it embeds the tunnel UUID, the connector credentials, and the account scope.

Leave the dashboard tab open — step 2 returns to it.

**Verify.**

```bash
# From the operator's machine, after the tunnel is created and `cloudflared` is
# logged in to the Cloudflare account that owns the tunnel
# (`cloudflared tunnel login`). The tunnel will show 0 connections at this stage —
# that is expected; we have not started a connector anywhere yet.
cloudflared tunnel list | grep -E '\bmurmur\b'
# expect: a single line with the tunnel name `murmur`, the recorded `<tunnel-uuid>`,
#         and the creation timestamp.
```

If the tunnel does not appear, recheck that you are authenticated against the Cloudflare account that owns `colophon-group.org` (`cloudflared tunnel login` opens a browser; the URL it prints must point at that account's dashboard).

---

## 2. Add the public hostname route

**Action.** Still in the Zero Trust → Networks → Tunnels view for `murmur`:

1. Open the **Public Hostname** tab.
2. Click **Add a public hostname**.
3. **Subdomain:** `murmur`.
4. **Domain:** `colophon-group.org` (must already be onboarded to this Cloudflare account; if it is not, you cannot proceed — the dashboard will not list it in the dropdown).
5. **Path:** leave empty (route everything).
6. **Service type:** `HTTP`.
7. **URL:** `localhost:8080`. (No scheme prefix — the dashboard adds `http://`.)
8. Click **Save hostname**.

Cloudflare auto-creates a proxied CNAME `murmur.colophon-group.org` → `<tunnel-uuid>.cfargotunnel.com`. Do **not** create a manual A record — the tunnel-managed CNAME is the only correct record, and a stray A record will shadow it.

**Verify.**

```bash
# From any machine with public DNS resolution:
dig +short murmur.colophon-group.org
# expect: a small set of Cloudflare anycast IPs (104.x.x.x or 172.x.x.x range).
#         These are NOT the Hetzner box IP — that is the whole point of the tunnel.

dig +noall +answer murmur.colophon-group.org CNAME
# expect: murmur.colophon-group.org. <ttl> IN CNAME <tunnel-uuid>.cfargotunnel.com.
```

If `dig` returns the Hetzner box IPv4 directly, a stale A record exists. Delete it from Cloudflare DNS → `colophon-group.org` and let the tunnel-managed CNAME stand alone.

---

## 3. Save the tunnel token as a GitHub `production` secret

The `cloudflared` sidecar in `docker-compose.yml` (delivered by `colophon-group/murmur#18`, currently blocked on M1) consumes this secret as `${CLOUDFLARE_TUNNEL_TOKEN}` at deploy time. The deploy workflow (`#19`) writes it into `/home/deploy/.env` from the GH secret.

**Action.** From the operator's machine, with `gh` authenticated:

```bash
# Place the token value (the base64 blob copied from step 1) into a local shell
# variable. The recommended form reads from a TTY prompt so the value never lands
# in shell history. `read -rs` is the silent variant (no echo).
read -rs CLOUDFLARE_TUNNEL_TOKEN_VALUE
# (paste the token, press Enter — no characters echo)

# Upsert the secret via stdin, NOT via --body "$VAR" — `--body` exposes the value on
# the command line where it lands in `ps`, shell history, and any audit log that
# captures argv. The `< <(printf '%s' "$VAR")` form pipes the bytes through stdin.
gh secret set CLOUDFLARE_TUNNEL_TOKEN \
  --env production \
  --repo colophon-group/murmur \
  < <(printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN_VALUE")

# Scrub the variable from the current shell. (Closing the terminal also works,
# but explicit is better — and the variable is in `env` until you do.)
unset CLOUDFLARE_TUNNEL_TOKEN_VALUE
```

The `production` environment scope (not the repo scope) is deliberate: GH Environment secrets gate on the environment's protection rules, so a PR from a fork cannot read this secret. See `docs/bootstrap.md` step 6 for the corresponding entry — the same secret name is referenced there.

**Verify.**

```bash
gh secret list --env production --repo colophon-group/murmur | grep CLOUDFLARE_TUNNEL_TOKEN
# expect: a single line, secret name + last-updated timestamp. Values are never shown.
```

If the secret does not appear, confirm the `production` environment exists (GH → Settings → Environments → New environment → name `production`); `gh secret set --env <name>` does **not** auto-create the environment.

---

## 4. Connector via the compose `cloudflared` sidecar

The production topology runs `cloudflared` as a Docker sidecar in the compose stack on the Hetzner box, per `DESIGN.md` §6.2. The sidecar consumes `CLOUDFLARE_TUNNEL_TOKEN` from `/home/deploy/.env` (written by the deploy workflow from the GH secret in step 3). The compose definition is owned by issue `colophon-group/murmur#18`; this runbook does not edit `docker-compose.yml`.

The relevant excerpt from `DESIGN.md` §6.2 (do not duplicate-and-edit; refer to the spec):

```yaml
cloudflared:
  image: cloudflare/cloudflared:latest
  network_mode: host
  restart: unless-stopped
  command: tunnel --no-autoupdate run
  environment:
    TUNNEL_TOKEN: "${CLOUDFLARE_TUNNEL_TOKEN}"
```

`network_mode: host` is required so the sidecar can reach the murmur container on `localhost:8080` (also `network_mode: host`) without an explicit Docker network. `restart: unless-stopped` covers the reconnect-on-crash case; the connector additionally retries with backoff against the Cloudflare edge if the dial-out fails.

**Verify (after compose lands and is deployed).**

```bash
# On the box (ssh deploy@<box-ipv4>):
docker compose -f /home/deploy/compose.yaml ps cloudflared
# expect: cloudflared container, status Up.

docker compose -f /home/deploy/compose.yaml logs --tail=50 cloudflared
# expect: lines containing `Registered tunnel connection` (one or more, one per Cloudflare edge POP).

# From the operator's machine (with cloudflared logged in to the Cloudflare account):
cloudflared tunnel info murmur
# expect: tunnel UUID matches <tunnel-uuid>; "1 active connection" or more; connector ID
#         matches the box hostname.
```

If `cloudflared tunnel info murmur` shows zero connections after the compose stack is up, recheck (a) the GH secret value (`gh secret list --env production`), (b) that the deploy workflow propagated it into `/home/deploy/.env` on the box, and (c) the sidecar logs for an `Unauthorized` or `failed to dial` line — `Unauthorized` means a stale or wrong token; `failed to dial` means egress is blocked (Cloudflare uses TCP/443 to `*.cloudflare.com`).

---

## 5. End-to-end verification (live, deferred to operator)

These checks require the live tunnel up against a deployed murmur. Run them once after step 4 succeeds, before the demo. None can be executed from this PR's CI.

```bash
# (a) Public URL serves with valid TLS — from a non-VPN external network:
curl -I https://murmur.colophon-group.org/health
# expect: HTTP/2 200 (or HTTP/1.1 200 OK), valid TLS cert (issuer: Cloudflare/Google Trust),
#         server header includes `cloudflare`.

# (b) DNS returns Cloudflare IPs (not the box IP):
dig +short murmur.colophon-group.org
# expect: 104.x.x.x or 172.x.x.x range. NOT the box IPv4.

# (c) No inbound 8080 (or any service port) from the public internet — the box should be
#     reachable only on 22 (SSH from the operator) and ICMP. 80/443/8080 must be closed:
nmap -p 22,80,443,8080 <box-ipv4>
# expect: 22 open (filtered if a firewall is in place), 80/443/8080 closed or filtered.
#         If 8080 is `open`, the box's firewall is misconfigured — the tunnel works
#         either way, but a public 8080 is a security hole that bypasses Cloudflare.

# (d) Tunnel reports connected:
cloudflared tunnel info murmur
# expect: at least one active connection.

# (e) Forced restart of cloudflared reconnects within ~10s:
ssh deploy@<box-ipv4> 'docker compose -f /home/deploy/compose.yaml restart cloudflared'
sleep 12
curl -sS -o /dev/null -w '%{http_code}\n' https://murmur.colophon-group.org/health
# expect: 200. If 502 or 521 persists past ~30s, see Recovery below.
```

---

## 6. Long-lived MCP connection smoke (manual, before demo)

The MCP transport is **Streamable HTTP** (per `DESIGN.md` §6.2 — the 2025-03 MCP spec replacement for SSE) plus 25s server-side keepalive pings. Both choices were made specifically because Cloudflare Tunnel has historically been poor at long-idle SSE — intermediaries silently drop the connection at ~100s of inactivity, and the legacy SSE transport had no application-level keepalive.

A docs-only check cannot validate this; the operator must run the smoke once before the demo:

1. Open `mcp-inspector` (or any MCP client) against `https://murmur.colophon-group.org/mcp`.
2. Authenticate with a valid bearer token (`MURMUR_TOKEN` from the GH `production` environment).
3. Issue one tool call (any cheap call — `pull` with a deliberately empty filter is fine).
4. Idle for **90 seconds** (set a timer; eyeballing is unreliable here — a 70s idle won't trigger the failure mode).
5. Issue a second tool call.

**Pass:** the second call returns a normal response.
**Fail:** the second call hangs, returns 502, or the MCP client surfaces "connection closed". File an issue against `colophon-group/murmur` labelled `area:transport type:bug`, attach the inspector log, and *do not* run the demo until it is resolved — the demo includes idle gaps longer than 90s.

---

## 7. Quality gates (settings, not commands)

These are configuration choices applied in the Cloudflare dashboard. They do not have a CLI verification but should be visually confirmed once during step 1 / step 2:

- **Tunnel access policy:** public route. Do **not** require Cloudflare Access for the demo. (For non-demo deployments, gating MCP behind Access is reasonable; out of scope here.)
- **DNS record:** auto-managed by the tunnel (the CNAME created in step 2). No manual A record. Confirm in Cloudflare DNS → `colophon-group.org` that `murmur` is the *only* record for that subdomain, and that it is a `CNAME` to `<tunnel-uuid>.cfargotunnel.com`.

---

## Recovery — what to do when a step fails

Every step is reversible. Identify which step failed by the verification command that returned the wrong result, then apply the matching recipe.

### Placeholder gate

If `grep -n 'REPLACE:' docs/cloudflare-tunnel.md` exits 0 (matches found) at *any* point while running this runbook, stop. A placeholder leaked through. Fix the file (or, if running from a fork, fix your local copy) and re-run from step 0 — every step is idempotent, so re-running is safe.

### Step 1 (tunnel creation) failed

If the tunnel was created with the wrong name or against the wrong account: in the Zero Trust dashboard, open the tunnel and choose **Delete tunnel**. Then re-run step 1. There is no per-account quota concern — you can create and delete tunnels freely.

If `cloudflared tunnel list` does not show `murmur` after creation: confirm `cloudflared tunnel login` authenticated against the right account (the browser flow shows the account name in the redirect URL).

### Step 2 (hostname route) failed

If the hostname route resolves but `dig` returns the box IP (not Cloudflare IPs): a stale A record is shadowing the tunnel-managed CNAME. Delete the A record from Cloudflare DNS → `colophon-group.org` and let the CNAME stand. Re-verify with `dig +short murmur.colophon-group.org` — it should return Cloudflare anycast IPs within ~30s of TTL.

If the hostname route saved but the dashboard shows "Service: Inactive": the tunnel has no active connector yet — proceed to step 4 (the sidecar is what registers a connection). The dashboard updates within a few seconds of the connector establishing its first edge connection.

### Step 3 (GH secret) failed

The `gh secret set` form is an upsert. Re-run the command. If the failure is `HTTP 404: Not Found`, the `production` environment does not exist on the repo — create it under Settings → Environments → New environment, then re-run.

If you suspect the secret was set with leading/trailing whitespace (a common copy-paste mistake), re-run step 3 with the token piped through `tr -d '[:space:]'`:

```bash
gh secret set CLOUDFLARE_TUNNEL_TOKEN \
  --env production \
  --repo colophon-group/murmur \
  < <(printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN_VALUE" | tr -d '[:space:]')
```

### Step 4 (connector) failed

If the sidecar logs show `Unauthorized` or `tunnel token is invalid`: the GH secret is stale (the dashboard rotated the token, or the wrong tunnel's token was saved). Regenerate the token in the Cloudflare dashboard (Zero Trust → Tunnels → `murmur` → "Refresh token") and re-run step 3. Then redeploy (the sidecar reads `TUNNEL_TOKEN` only at process start, so a `docker compose up -d cloudflared` is required after the env file changes).

If the sidecar logs show `failed to dial` or repeated `connection reset`: egress to Cloudflare is blocked. Confirm the box can reach `region1.v2.argotunnel.com` on TCP/443:

```bash
ssh deploy@<box-ipv4> 'curl -sS -o /dev/null -w "%{http_code}\n" https://region1.v2.argotunnel.com/'
# expect: 404 (Cloudflare returns 404 for the bare path; the point is that the TLS handshake completes).
```

If the box-side install (systemd `cloudflared.service`, per `docs/bootstrap.md` step 5) is running concurrently with the Docker sidecar, **they will fight over the same tunnel** — Cloudflare load-balances connections across all connectors registered to a tunnel, but two connectors on the same box pointed at the same `localhost:8080` is wasteful and confusing. Pick one:

- **Production target (per `DESIGN.md` §6.2):** Docker sidecar. Stop the systemd service: `ssh deploy@<box-ipv4> 'sudo systemctl disable --now cloudflared'`. The service can be re-enabled later if needed.
- **Pre-D1 stopgap:** systemd. Comment out the cloudflared sidecar in compose (when D1 lands) until the operator chooses to switch.

### Step 5 (e2e verification) failed

If `curl -I https://murmur.colophon-group.org/health` returns 502 with the tunnel showing "active": the murmur container is not up or not healthy. SSH to the box and check `docker compose ps` + `docker compose logs murmur`. The tunnel is doing its job; the backend isn't.

If `curl` returns 521 (Cloudflare's "web server is down" code): no connector is registered. Re-run step 4 verification.

If `nmap` shows port 8080 open from the public internet: the box's firewall (`ufw` or Hetzner Cloud firewall) is letting 8080 through. Close it — the tunnel does not need it. Quick fix:

```bash
ssh root@<box-ipv4> 'ufw deny 8080 && ufw reload'
```

### Step 6 (long-lived smoke) failed

This is a hard fail before the demo — file the bug, do not paper over it. Triage path: capture `cloudflared` logs during the 90s idle, look for `connection closed by client` or `idle timeout`, and either tune the keepalive interval (server-side, in the Murmur transport layer) or upgrade to a different tunnel topology. Out of scope for this runbook.

### Full rollback

If the tunnel is irrecoverably broken:

```bash
# From the operator's machine:
cloudflared tunnel cleanup murmur     # delete stale connector records
# Then in the dashboard: Zero Trust → Tunnels → murmur → Delete tunnel.
# Re-run from step 1.
```

The hostname CNAME in DNS is auto-deleted with the tunnel. The GH secret can be left in place (it will simply be ignored until step 3 is re-run with a fresh token).
