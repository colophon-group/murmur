# Murmur auth model (M1)

**Status:** Active. Replaces the §3.6 single-bearer demo model with the
multi-tenant token foundation introduced in #81. The agent surface
(`/work`, `/mcp`) remains on the legacy bearer until M2 introduces the
agent-plane split.

## Three planes

Murmur sits between three actor classes; each has its own credential
shape and gate.

| Plane | Direction | Credential | Gate |
|---|---|---|---|
| Machine (publisher → Murmur) | inbound | `publisher_admin_token`, `publisher_runner_token` | `publisherAuth(db)` middleware on `/pipelines*`, `/runs*`, `/publishers/me*` |
| Machine (Murmur → publisher) | outbound | `webhook_signing_secret` (HMAC), `subcommand_bearer` (Authorization) | Murmur signs / injects; publisher verifies |
| Agent | inbound | `MURMUR_TOKEN` (legacy single-bearer) | `bearerAuth(token)` on `/work*`, `/mcp*` |
| Bootstrap | inbound | `MURMUR_BOOTSTRAP_TOKEN` (deployment-wide) | `bootstrapAuth(token)` on `POST /publishers` |

The four publisher-scoped credentials rotate independently — leaking
one does not escalate to another.

## Token shape

A Murmur publisher token carries 256 bits of CSPRNG entropy in its
random tail:

```
mp_<scope>_<base64url(32 random bytes)>
```

`<scope>` is one of `admin`, `runner`, `webhook_signing`,
`subcommand_bearer`, or `bootstrap`. The visible scope is for operator
ergonomics; the DB-side `publisher_tokens.kinds_json` is the
authoritative grant set.

Storage:

| Column | Storage | Why |
|---|---|---|
| `publisher_tokens.secret_hash` | SHA-256 hex | High-entropy random input → SHA-256 alone is collision-resistant; no salt required (Stripe/Slack/GitHub model). |
| `publisher_secrets.secret_value` | plaintext | Murmur needs the cleartext to sign webhooks (HMAC) and inject as `Authorization: Bearer` on subcommand proxy. The SQLite file is treated as a secret on par with `MURMUR_TOKEN`; encryption-at-rest is M2-track. |

## Lifecycle

### 1. Bootstrap a new publisher

```bash
curl -X POST https://murmur.example.org/publishers \
     -H "Authorization: Bearer $MURMUR_BOOTSTRAP_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"slug": "acme", "display_name": "Acme Corp"}'
```

Returns `201` with the minted admin token AND the initial webhook
signing + subcommand bearer secrets, **once**:

```json
{
  "ok": true,
  "data": {
    "id": "pub_a3b9...",
    "slug": "acme",
    "display_name": "Acme Corp",
    "admin_token": { "id": "...", "token": "mp_admin_...", "prefix": "...12345" },
    "webhook_signing_secret": { "id": "...", "value": "...", "prefix": "..." },
    "subcommand_bearer": { "id": "...", "value": "...", "prefix": "..." }
  }
}
```

Capture every secret from this response — only the prefixes are
queryable later via `GET /publishers/me`.

### 2. Register a pipeline

```bash
curl -X POST https://murmur.example.org/pipelines \
     -H "Authorization: Bearer $ACME_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"id": "...", "def_yaml": "..."}'
```

Requires the `admin` kind. Cross-publisher slug collisions return
`409 publisher_id_taken_by_other_publisher` (note: pipeline ids remain
globally unique in v1).

### 3. Trigger a run

```bash
curl -X POST https://murmur.example.org/pipelines/jobseek-add-company/runs \
     -H "Authorization: Bearer $ACME_RUNNER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"initial_input": {...}}'
```

Requires `admin` OR `runner` kind. Cross-publisher pipeline lookups
return `404 pipeline_not_found` (no information leak).

### 4. Rotate a token

```bash
curl -X POST https://murmur.example.org/publishers/me/tokens/admin/rotate \
     -H "Authorization: Bearer $ACME_ADMIN_TOKEN"
```

Returns the new admin plaintext **once**. The old admin row is revoked
in the same transaction. Run prior to disclosure of compromise; capture
the new value before propagating to CI.

`{kind}` ∈ `admin`, `runner`, `webhook_signing`, `subcommand_bearer`.
For the latter two, the response field is `value` (not `token`) and
holds the new plaintext.

### 5. Revoke a specific token row

```bash
curl -X DELETE https://murmur.example.org/publishers/me/tokens/admin/$ROW_ID \
     -H "Authorization: Bearer $ACME_ADMIN_TOKEN"
```

Targets a specific `publisher_tokens.id` (visible via `GET /publishers/me`).
Useful for revoking a single grandfathered or legacy token without
rotating the whole admin cohort.

## Webhook HMAC verification

Murmur signs every webhook delivery with `webhook_signing_secret`. The
signature header is:

```
X-Murmur-Signature: t=<unix-seconds>,v1=<hex-lowercase>
```

`v1` = `HMAC-SHA256(<secret>, "<unix>.<body>")`, hex-lowercase, 64
chars.

### Verifier — Node.js

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyMurmurSignature(req, secret, freshnessSec = 300) {
  const header = req.headers["x-murmur-signature"];
  if (!header) return { ok: false, reason: "missing_signature" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2))
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return { ok: false, reason: "malformed_signature" };

  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(ageSec) || ageSec > freshnessSec) {
    return { ok: false, reason: "stale_signature" };
  }

  const body = req.rawBody; // raw bytes — MUST NOT be re-stringified JSON
  const expected = createHmac("sha256", secret)
    .update(`${t}.${body}`, "utf8")
    .digest("hex");

  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
```

### Verifier — Python

```python
import hmac, hashlib, time

def verify_murmur_signature(headers, raw_body, secret, freshness_sec=300):
    header = headers.get("x-murmur-signature")
    if not header:
        return False, "missing_signature"
    parts = dict(p.split("=", 1) for p in header.split(","))
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False, "malformed_signature"
    if abs(int(time.time()) - int(t)) > freshness_sec:
        return False, "stale_signature"
    expected = hmac.new(
        secret.encode("utf-8"),
        f"{t}.{raw_body.decode('utf-8')}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(v1, expected):
        return False, "bad_signature"
    return True, None
```

### Replay protection

A valid signature within the freshness window is **not** enough — the
publisher's accept handler MUST also dedupe on `Idempotency-Key:
<run_id>`. Persist applied keys for at least:

```
freshness_window + retry_delay = 300s + 30s = 330s ≈ 6 minutes
```

Murmur retries once on non-2xx after 30 seconds (DESIGN.md §3.6); a
captured webhook can be replayed within that window with the original
signature still valid, but the publisher's writer-side UNIQUE constraint
on `Idempotency-Key` is the durable boundary.

### Backward compat (legacy bearer)

Murmur ALSO sends `Authorization: Bearer <subcommand_bearer-or-MURMUR_TOKEN>`
on every webhook delivery. Publishers that haven't migrated to verify
HMAC yet continue to accept on the bearer — both headers are sent
additively. The legacy bearer is dropped in M10 cutover.

## Demo publisher (jobseek)

The 0002 migration seeds `pub_demo_seed` as a placeholder publisher
row. The boot-time seed in `src/db/bootstrap.ts` then:

1. Overrides slug + display_name from `MURMUR_BOOTSTRAP_PUBLISHER_SLUG`
   / `_NAME` env vars (defaults `demo` / `Demo Publisher`).
2. Hashes `MURMUR_TOKEN` and inserts as a single `publisher_tokens`
   row with `kinds_json='["admin","runner"]'`. Source:
   `env_grandfather`.
3. Sets `subcommand_bearer = MURMUR_TOKEN` (so the existing
   `task_tool` dispatch path works unchanged).
4. Generates a fresh random `webhook_signing_secret` (so HMAC signing
   works on every delivery).

`MURMUR_TOKEN` rotation between boots is detected (hash mismatch); the
stale grandfather row is revoked and a fresh one inserted. Operators
who want the runner / admin token to NOT equal `MURMUR_TOKEN` should
rotate via `POST /publishers/me/tokens/{kind}/rotate` after first boot.

## Audit log

Every machine-plane admin action writes one row to
`publisher_audit_events`. Vocabulary (closed v1 set):

- `publisher_created` — bootstrap minted a new publisher
- `publisher_updated` — `PATCH /publishers/me` changed metadata
- `token_minted` — new `publisher_tokens` row inserted
- `token_rotated` — admin/runner rotation
- `token_revoked` — explicit revocation
- `secret_rotated` — webhook_signing / subcommand_bearer rotation
- `secret_revoked` — explicit secret revocation
- `bootstrap_invoked` — `POST /publishers` was called

`last_used_at` is **deliberately not tracked** in v1 — the writer-lock
contention storming the auth path is not worth the telemetry value.
M2 introduces a batched background updater.

## Known limitations (v1)

- **Pipeline IDs are globally unique** (PRIMARY KEY on `pipelines.id`).
  Per-publisher namespacing requires a table rebuild and is deferred
  until multiple non-demo publishers exist. The UPSERT scopes by
  `publisher_id` to prevent silent overwrites; cross-publisher slug
  collisions surface as 409.
- **Plaintext outgoing-secret storage.** `webhook_signing_secret`
  and `subcommand_bearer` live in plaintext in SQLite. Encryption-at-rest
  + KMS-backed key management is M2 scope. SQLite file backups
  must be treated as containing secrets.
- **No DNS rebinding defense.** URL validation runs at registration;
  an attacker who controls the DNS for an allow-listed hostname could
  point it at a private IP at dispatch time. Mitigation requires a
  per-request resolution check + IP pinning.
- **No `last_used_at` telemetry.** Tokens that haven't been used in
  weeks are indistinguishable from active tokens until M2.
- **Bootstrap rate limiting** — `POST /publishers` has no per-IP rate
  limit in v1. Keep `MURMUR_BOOTSTRAP_TOKEN` operator-only and rotate
  it independently from `MURMUR_TOKEN`.
- **5-minute replay window** — publishers that don't dedupe on
  `Idempotency-Key` are vulnerable to in-window replays.

## Operator runbook — first-time bootstrap

For a fresh deployment that's NOT inheriting a demo `MURMUR_TOKEN`:

```bash
# On the deploy host:
export MURMUR_BOOTSTRAP_TOKEN="$(openssl rand -base64url 32)"
echo "MURMUR_BOOTSTRAP_TOKEN=$MURMUR_BOOTSTRAP_TOKEN" >> /etc/murmur.env
systemctl restart murmur

# From the operator's laptop:
curl -X POST https://murmur.example.org/publishers \
     -H "Authorization: Bearer $MURMUR_BOOTSTRAP_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"slug": "acme", "display_name": "Acme Corp"}' \
     | tee acme-bootstrap.json

# Capture the admin token + webhook_signing + subcommand_bearer from the
# response (each appears exactly once, in plaintext). Distribute via
# password manager. After confirming acme's CI works, ROTATE the admin
# token and zero out MURMUR_BOOTSTRAP_TOKEN on the deploy host.
```

## Cross-references

- `src/db/migrations/0002_publishers_and_tokens.sql` — schema
- `src/auth/publisher_auth.ts` — middleware + `requireKind` / `requireAnyKind`
- `src/auth/bootstrap_auth.ts` — `POST /publishers` gate
- `src/auth/tokens.ts` — token mint + hash primitives
- `src/db/bootstrap.ts` — boot-time demo seed
- `src/api/publisher/admin.ts` — `/publishers/me/*` admin handlers
- `src/audit/publisher_audit.ts` — audit log writer
- `src/webhook.ts` — HMAC signature header (`lookupActiveWebhookSigningSecret`)
- `src/dispatch/task_tool.ts` — per-publisher `subcommand_bearer` injection
- `packages/contracts-types/src/headers.ts` — `X_MURMUR_SIGNATURE`
