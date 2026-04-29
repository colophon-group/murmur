"""Smoke test: load `docs/contracts/fixtures/all-seven.json` and
materialise the relevant dataclasses from `docs/contracts.py`.

Run:
    python3 docs/contracts/fixtures/check_python.py

Exits 0 on success; non-zero on any parse/type error.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Make `docs/contracts.py` importable when run from anywhere in the repo.
HERE = Path(__file__).resolve()
DOCS = HERE.parent.parent.parent  # .../<repo>/docs
REPO = DOCS.parent
sys.path.insert(0, str(DOCS))

# Imported via the file path the issue mandates (`docs/contracts.py`).
import contracts as c  # type: ignore[import-not-found]  # noqa: E402

FIXTURE = HERE.parent / "all-seven.json"


def main() -> int:
    blob = json.loads(FIXTURE.read_text())

    # §1 — pipeline def
    p = blob["1_pipeline_def"]
    pipeline = c.PipelineDef(
        id=p["id"],
        initial_input=p["initial_input"],
        subtasks=tuple(
            c.SubtaskDef(
                id=s["id"],
                instructions=s["instructions"],
                output_schema=s["output_schema"],
                subcommands=tuple(
                    c.SubcommandDef(
                        name=sc["name"],
                        endpoint=sc["endpoint"],
                        input_schema=sc.get("input_schema"),
                    )
                    for sc in s.get("subcommands", [])
                ),
                spawns=(
                    c.SpawnsDef(for_each=s["spawns"]["for_each"], template=s["spawns"]["template"])
                    if "spawns" in s
                    else None
                ),
            )
            for s in p["subtasks"]
        ),
        final_output=c.FinalOutputDef(
            composes=tuple(p["final_output"]["composes"]),
            webhook=p["final_output"]["webhook"],
        ),
    )
    assert pipeline.id == "jobseek-add-company"
    assert len(pipeline.subtasks) == 4

    # §3 — header strings match the constants
    h = blob["3_proxy_headers"]
    assert c.HEADER_AUTHORIZATION in h
    assert c.HEADER_X_MURMUR_SUBCOMMAND in h
    assert c.HEADER_X_MURMUR_CLAIM_TOKEN in h

    # §4 — envelope OK
    ok = blob["4_envelope_ok"]
    env_ok: c.EnvelopeResponse[dict] = c.Ok(data=ok["data"])
    assert env_ok.ok is True
    assert c.is_ok(env_ok)

    # §4 — envelope Err (token form)
    err = blob["4_envelope_err_token"]
    env_err: c.EnvelopeResponse[None] = c.Err(errors=tuple(err["errors"]))
    assert env_err.ok is False
    assert c.is_err(env_err)

    # §5 — validation-error envelope
    ve = blob["5_validation_error_envelope"]
    val_err = c.Err(
        errors=tuple(
            c.ValidationError(path=e["path"], message=e["message"], code=e.get("code"))
            for e in ve["errors"]
        ),
    )
    assert all(isinstance(e, c.ValidationError) for e in val_err.errors)
    # JSON Pointer rules: empty string or starts with "/"
    for e in val_err.errors:
        assert isinstance(e, c.ValidationError)
        assert e.path == "" or e.path.startswith("/")

    # §6 — webhook payload + headers
    w = blob["6_webhook"]
    payload = c.WebhookPayload(
        run_id=w["body"]["run_id"],
        pipeline_id=w["body"]["pipeline_id"],
        pipeline_version=w["body"]["pipeline_version"],
        completed_at=w["body"]["completed_at"],
        final_output=w["body"]["final_output"],
    )
    assert w["headers"][c.HEADER_IDEMPOTENCY_KEY] == payload.run_id
    assert w["headers"][c.HEADER_AUTHORIZATION].startswith(c.BEARER_PREFIX)
    assert w["retry_count"] == c.WEBHOOK_RETRY_COUNT
    assert w["retry_delay_ms"] == c.WEBHOOK_RETRY_DELAY_MS
    assert w["dedupe_window_ms"] is c.WEBHOOK_DEDUPE_WINDOW_MS

    # §7 — composes examples cover all primitives
    ce = blob["7_composes_examples"]
    assert ce["wildcard"].endswith(".*")
    assert ce["wildcard_prefix"].endswith("_*")
    assert ":" in ce["rename"]
    assert "×" in ce["cartesian"]
    assert "flatten(" in ce["flatten"]

    # §4 — fixture has no `"accepted":` key (single-envelope rule).
    raw = FIXTURE.read_text()
    assert '"accepted"' not in raw, "fixture must not use the legacy `accepted` envelope shape"

    print("docs/contracts.py: fixture round-trip OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
