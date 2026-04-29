"""Boundary contract types for Murmur ↔ jobseek (Python side).

Mirrors `packages/contracts-types/` (TypeScript). Authoritative prose
lives in `docs/contracts.md`; authoritative runtime schemas live in
`docs/contracts/pipeline-def.schema.json`.

Consumed by jobseek's crawler refactor (issues #2755, #2756, #2759,
#2760, #2761, #2763). Imported from this file path verbatim — keep the
relative-path stable.

Standard-library only (`dataclasses`, `typing`); no third-party deps.
Python ≥ 3.11 (jobseek's existing target).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final, Generic, Literal, Mapping, Sequence, TypeVar, Union

# ---------------------------------------------------------------------------
# §3 — Header name constants. Casing is locked; both repos pin the strings.
# ---------------------------------------------------------------------------

HEADER_AUTHORIZATION: Final[str] = "Authorization"
HEADER_X_MURMUR_SUBCOMMAND: Final[str] = "X-Murmur-Subcommand"
HEADER_X_MURMUR_CLAIM_TOKEN: Final[str] = "X-Murmur-Claim-Token"
HEADER_IDEMPOTENCY_KEY: Final[str] = "Idempotency-Key"

MURMUR_HEADERS: Final[Mapping[str, str]] = {
    "AUTHORIZATION": HEADER_AUTHORIZATION,
    "X_MURMUR_SUBCOMMAND": HEADER_X_MURMUR_SUBCOMMAND,
    "X_MURMUR_CLAIM_TOKEN": HEADER_X_MURMUR_CLAIM_TOKEN,
    "IDEMPOTENCY_KEY": HEADER_IDEMPOTENCY_KEY,
}

# ---------------------------------------------------------------------------
# §2 — MURMUR_TOKEN spec (reference values for tests / validators).
# ---------------------------------------------------------------------------

BEARER_PREFIX: Final[str] = "Bearer "

@dataclass(frozen=True)
class MurmurTokenSpec:
    """Reference spec for `MURMUR_TOKEN`. See `docs/contracts.md` §2."""

    min_length: int = 32
    char_class: str = "[A-Za-z0-9_-]"
    comparison: Literal["timing-safe"] = "timing-safe"
    rotation: Literal["per-deployment"] = "per-deployment"


MURMUR_TOKEN_SPEC: Final[MurmurTokenSpec] = MurmurTokenSpec()


# ---------------------------------------------------------------------------
# §4 / §5 — Envelope and ValidationError.
# ---------------------------------------------------------------------------

T = TypeVar("T")


@dataclass(frozen=True)
class ValidationError:
    """Per-field validation error. `path` is a JSON Pointer (RFC 6901)."""

    path: str
    message: str
    code: str | None = None


@dataclass(frozen=True)
class Ok(Generic[T]):
    """Successful envelope. `data` may be omitted (e.g. successful submit)."""

    data: T | None = None
    ok: Literal[True] = field(default=True, init=False)


@dataclass(frozen=True)
class Err:
    """Failed envelope. `errors` MUST be populated."""

    errors: Sequence[Union[str, ValidationError]]
    ok: Literal[False] = field(default=False, init=False)


EnvelopeResponse = Union[Ok[T], Err]
"""The single canonical envelope shape. No parallel `{accepted: ...}`."""


def is_ok(response: EnvelopeResponse[T]) -> bool:
    """Type guard: True iff `response` is the OK branch."""

    return isinstance(response, Ok)


def is_err(response: EnvelopeResponse[T]) -> bool:
    """Type guard: True iff `response` is the Err branch."""

    return isinstance(response, Err)


# ---------------------------------------------------------------------------
# §6 — Webhook contract.
# ---------------------------------------------------------------------------

WEBHOOK_RETRY_COUNT: Final[int] = 1
WEBHOOK_RETRY_DELAY_MS: Final[int] = 30_000
WEBHOOK_DEDUPE_WINDOW_MS: Final[None] = None  # durable on writer side


@dataclass(frozen=True)
class WebhookPayload:
    """Body of the webhook POST. Headers (Authorization, Idempotency-Key,
    Content-Type) are not part of this dataclass — they are set on the
    HTTP request directly."""

    run_id: str
    pipeline_id: str
    pipeline_version: int
    completed_at: str
    final_output: Mapping[str, Any]


# ---------------------------------------------------------------------------
# §1 — Pipeline-def shape (TypeScript mirror of pipeline-def.schema.json).
# Runtime validation is the JSON Schema's job; these types exist for
# typed Python callers (jobseek crawler).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InputRef:
    from_: str
    path: str | None = None


@dataclass(frozen=True)
class SubcommandDef:
    name: str
    endpoint: str  # "POST <https-url>"
    input_schema: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class SpawnsDef:
    for_each: str
    template: str


@dataclass(frozen=True)
class SubtaskDef:
    id: str
    instructions: str
    output_schema: Mapping[str, Any]
    inputs: Sequence[InputRef] = ()
    subcommands: Sequence[SubcommandDef] = ()
    spawns: SpawnsDef | None = None
    requires: Sequence[str] = ()
    skip_if: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class FinalOutputDef:
    composes: Sequence[str]
    webhook: str


@dataclass(frozen=True)
class PipelineDef:
    id: str
    initial_input: Mapping[str, Any]
    subtasks: Sequence[SubtaskDef]
    final_output: FinalOutputDef
    version: int | None = None


# ---------------------------------------------------------------------------
# §1 — Demo-path subtask payload shapes (typed handles; JSON Schema is
# authoritative for runtime validation).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class KBEntry:
    slug: str
    title: str
    body: str
    tags: Sequence[str] = ()


@dataclass(frozen=True)
class CaseStudy:
    slug: str
    summary: str
    body: str


@dataclass(frozen=True)
class PreVerifyInput:
    company_name: str
    website: str


@dataclass(frozen=True)
class PreVerifyOutput:
    verified: bool
    canonical_name: str
    canonical_website: str
    reject_reason: str | None = None
    kb_entries: Sequence[KBEntry] = ()
    case_studies: Sequence[CaseStudy] = ()


@dataclass(frozen=True)
class SetupMetadataInput:
    canonical_name: str
    canonical_website: str


@dataclass(frozen=True)
class SetupMetadataOutput:
    slug: str
    description: str
    industry_ids: Sequence[str]
    founded_year: int | None = None
    employee_count_range: str | None = None
    logo_url: str | None = None
    kb_entries: Sequence[KBEntry] = ()
    case_studies: Sequence[CaseStudy] = ()


@dataclass(frozen=True)
class DiscoveredBoard:
    alias: str
    board_url: str
    provider: str
    hreflang: str | None = None


@dataclass(frozen=True)
class ListBoardsInput:
    canonical_website: str


@dataclass(frozen=True)
class ListBoardsOutput:
    boards: Sequence[DiscoveredBoard]
    kb_entries: Sequence[KBEntry] = ()
    case_studies: Sequence[CaseStudy] = ()


@dataclass(frozen=True)
class ConfigureBoardInput:
    alias: str
    board_url: str
    provider: str


@dataclass(frozen=True)
class ConfigureBoardOutput:
    outcome: Literal["configured", "blocked"]
    monitor_type: str | None = None
    monitor_config: Mapping[str, Any] | None = None
    scraper_type: str | None = None
    scraper_config: Mapping[str, Any] | None = None
    verdict: Literal["ok", "needs-work", "rejected"] | None = None
    per_field: Mapping[str, Any] | None = None
    kb_entries: Sequence[KBEntry] = ()
    case_studies: Sequence[CaseStudy] = ()


SubtaskName = Literal["pre-verify", "setup-metadata", "list-boards", "configure-board"]
"""Demo-path subtask names."""


__all__ = [
    # Headers
    "HEADER_AUTHORIZATION",
    "HEADER_X_MURMUR_SUBCOMMAND",
    "HEADER_X_MURMUR_CLAIM_TOKEN",
    "HEADER_IDEMPOTENCY_KEY",
    "MURMUR_HEADERS",
    # Auth
    "BEARER_PREFIX",
    "MurmurTokenSpec",
    "MURMUR_TOKEN_SPEC",
    # Envelope
    "Ok",
    "Err",
    "EnvelopeResponse",
    "ValidationError",
    "is_ok",
    "is_err",
    # Webhook
    "WebhookPayload",
    "WEBHOOK_RETRY_COUNT",
    "WEBHOOK_RETRY_DELAY_MS",
    "WEBHOOK_DEDUPE_WINDOW_MS",
    # Pipeline
    "InputRef",
    "SubcommandDef",
    "SpawnsDef",
    "SubtaskDef",
    "FinalOutputDef",
    "PipelineDef",
    # Subtasks
    "KBEntry",
    "CaseStudy",
    "PreVerifyInput",
    "PreVerifyOutput",
    "SetupMetadataInput",
    "SetupMetadataOutput",
    "DiscoveredBoard",
    "ListBoardsInput",
    "ListBoardsOutput",
    "ConfigureBoardInput",
    "ConfigureBoardOutput",
    "SubtaskName",
]
