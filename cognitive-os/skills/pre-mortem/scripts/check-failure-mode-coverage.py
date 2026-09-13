#!/usr/bin/env python3
"""
check-failure-mode-coverage.py — deterministic validator for pre-mortem records.

Implements the contract in `cognitive-os/agent-practice/reasoning-gates.v1.json`.
Per the Sol review corrections record (Sol review corrections M1 + M2):

  M1: replace raw ≥3-mode check with category coverage + causal independence.
  M2: replace `warning_checked` boolean with `warning_check_status` enum
      (verified / refused / unverified) + `check_evidence` field (required
      when status is verified or refused).

Exit codes:
  0 = all required checks pass
  1 = validation failure (record has structural/coverage problems)
  2 = invocation error (bad input, malformed JSON, missing file)

The script validates structural coverage only. Qualitative plausibility
remains the skill's job. A passed pre-mortem proves coverage; it grants
no task authority.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

# Categories required for non-trivial work per reasoning-gates.v1.json.
REQUIRED_CATEGORIES = [
    "requirement",
    "evidence",
    "plan",
    "implementation",
    "verification",
    "operational",
    "security",
    "human",
]

# Warning check status enum (M2).
WARNING_CHECK_STATUSES = {"verified", "refused", "unverified"}

# Categories that require rollback recovery on each failure mode.
REQUIRES_ROLLBACK_APPLIES_TO = {"irreversible_action", "persistent_state_change"}

# Generic mechanism labels rejected by the skill.
GENERIC_LABELS = {
    "bugs",
    "bug",
    "unexpected issues",
    "unexpected issue",
    "issues",
    "problems",
    "misc",
    "miscellaneous",
    "various",
    "things",
    "edge cases",
}


def is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def normalize_mechanism(text: str) -> str:
    return text.strip().lower()


def make_error(code: str, **details: Any) -> dict[str, Any]:
    return {"code": code, **details}


def validate_record(record: Any) -> list[dict[str, Any]]:
    """Return list of error objects. Empty list means the record passed all checks."""
    errors: list[dict[str, Any]] = []

    if not isinstance(record, dict):
        errors.append(make_error("NOT_AN_OBJECT", message="record must be a JSON object"))
        return errors

    # Structural checks.
    if record.get("schema_version") != "1.0.0":
        errors.append(
            make_error(
                "SCHEMA_VERSION_INVALID",
                actual=record.get("schema_version"),
                expected="1.0.0",
            )
        )
    if not is_non_empty_string(record.get("expected_outcome")):
        errors.append(make_error("EXPECTED_OUTCOME_MISSING"))
    if not is_non_empty_string(record.get("commitment_boundary")):
        errors.append(make_error("COMMITMENT_BOUNDARY_MISSING"))

    applies_to = record.get("applies_to")
    if not isinstance(applies_to, list) or len(applies_to) == 0:
        errors.append(make_error("APPLIES_TO_MISSING"))

    failure_modes = record.get("failure_modes")
    if not isinstance(failure_modes, list):
        errors.append(make_error("FAILURE_MODES_NOT_ARRAY"))
        failure_modes = []  # type: ignore[assignment]

    accepted_risks = record.get("accepted_risks", [])
    if not isinstance(accepted_risks, list):
        errors.append(make_error("ACCEPTED_RISKS_NOT_ARRAY"))
        accepted_risks = []

    # Coverage checks (M1: category coverage + causal independence).
    if isinstance(failure_modes, list):
        seen_categories: set[str] = set()
        for mode in failure_modes:
            if isinstance(mode, dict) and isinstance(mode.get("category"), str):
                seen_categories.add(mode["category"])
        missing = [c for c in REQUIRED_CATEGORIES if c not in seen_categories]
        if missing:
            errors.append(
                make_error("CATEGORY_COVERAGE_INCOMPLETE", missing=missing)
            )

        # Per-mode field validation.
        mechanisms_normalized: list[tuple[str, str]] = []
        for idx, mode in enumerate(failure_modes):
            if not isinstance(mode, dict):
                errors.append(
                    make_error("MODE_NOT_OBJECT", mode_index=idx)
                )
                continue

            mode_id_raw = mode.get("id", f"<unnamed-{idx}>")
            mode_id = mode_id_raw if isinstance(mode_id_raw, str) else str(mode_id_raw)

            mechanism_raw = mode.get("mechanism")
            if not is_non_empty_string(mechanism_raw):
                errors.append(make_error("MECHANISM_EMPTY", mode_id=mode_id))
            else:
                mechanism_text: str = mechanism_raw  # type: ignore[assignment]
                mechanisms_normalized.append((mode_id, normalize_mechanism(mechanism_text)))

                if normalize_mechanism(mechanism_text) in GENERIC_LABELS:
                    errors.append(
                        make_error(
                            "MECHANISM_GENERIC",
                            mode_id=mode_id,
                            mechanism=mechanism_text,
                        )
                    )

            # M2: warning_check_status enum + check_evidence requirement
            status = mode.get("warning_check_status")
            if status not in WARNING_CHECK_STATUSES:
                errors.append(
                    make_error(
                        "WARNING_CHECK_STATUS_INVALID",
                        mode_id=mode_id,
                        actual=status,
                        expected=sorted(WARNING_CHECK_STATUSES),
                    )
                )
            elif status in {"verified", "refused"}:
                if not is_non_empty_string(mode.get("warning_check_evidence")):
                    errors.append(
                        make_error(
                            "WARNING_CHECK_EVIDENCE_MISSING",
                            mode_id=mode_id,
                            warning_check_status=status,
                        )
                    )

            # Rollback required for irreversible / persistent_state commitments.
            if (
                isinstance(applies_to, list)
                and any(a in REQUIRES_ROLLBACK_APPLIES_TO for a in applies_to)
                and not is_non_empty_string(mode.get("rollback_recovery"))
            ):
                errors.append(
                    make_error(
                        "ROLLBACK_RECOVERY_MISSING",
                        mode_id=mode_id,
                        applies_to=[a for a in applies_to if a in REQUIRES_ROLLBACK_APPLIES_TO],
                    )
                )

            disposition = mode.get("disposition")
            if disposition not in {"open", "mitigated", "accepted_risk", "blocked"}:
                errors.append(
                    make_error(
                        "DISPOSITION_INVALID",
                        mode_id=mode_id,
                        actual=disposition,
                    )
                )

            if not is_non_empty_string(mode.get("mitigation")):
                errors.append(
                    make_error("MITIGATION_EMPTY", mode_id=mode_id)
                )

        # M1: causal independence — duplicate normalized mechanisms.
        seen: dict[str, str] = {}
        for mode_id, norm in mechanisms_normalized:
            if norm in seen:
                errors.append(
                    make_error(
                        "CAUSAL_DEPENDENCE",
                        mechanism=norm,
                        mode_ids=[seen[norm], mode_id],
                    )
                )
            else:
                seen[norm] = mode_id

    # Waiver validation: every mode with disposition=accepted_risk must have
    # a matching waiver with authority_reference + no_additional_authority=true.
    if isinstance(failure_modes, list) and isinstance(accepted_risks, list):
        waivers_by_mechanism: dict[str, dict[str, Any]] = {}
        for waiver in accepted_risks:
            if not isinstance(waiver, dict):
                errors.append(make_error("WAIVER_NOT_OBJECT"))
                continue
            if is_non_empty_string(waiver.get("affected_mode_mechanism")):
                waivers_by_mechanism[
                    normalize_mechanism(waiver["affected_mode_mechanism"])
                ] = waiver

        for mode in failure_modes:
            if not isinstance(mode, dict):
                continue
            if mode.get("disposition") != "accepted_risk":
                continue
            mechanism_raw = mode.get("mechanism")
            if not is_non_empty_string(mechanism_raw):
                continue
            mechanism: str = mechanism_raw  # type: ignore[assignment]
            waiver = waivers_by_mechanism.get(normalize_mechanism(mechanism))
            if waiver is None:
                errors.append(
                    make_error(
                        "WAIVER_MISSING_FOR_ACCEPTED_RISK",
                        mechanism=mechanism,
                    )
                )
                continue
            if not is_non_empty_string(waiver.get("authority_reference")):
                errors.append(
                    make_error(
                        "WAIVER_AUTHORITY_REFERENCE_MISSING",
                        mechanism=mechanism,
                    )
                )
            if waiver.get("no_additional_authority") is not True:
                errors.append(
                    make_error(
                        "WAIVER_NO_ADDITIONAL_AUTHORITY_FALSE",
                        mechanism=mechanism,
                    )
                )
            for field in ("risk_owner", "scope", "review_or_expiry", "reason"):
                if not is_non_empty_string(waiver.get(field)):
                    errors.append(
                        make_error(
                            "WAIVER_FIELD_MISSING",
                            mechanism=mechanism,
                            field=field,
                        )
                    )

        # Orphan waivers: must reference an actual mode with accepted_risk disposition.
        for waiver in accepted_risks:
            if not isinstance(waiver, dict):
                continue
            affected_raw = waiver.get("affected_mode_mechanism")
            if not is_non_empty_string(affected_raw):
                continue
            affected: str = affected_raw  # type: ignore[assignment]
            norm_affected = normalize_mechanism(affected)
            covered = (
                next(
                    (
                        m
                        for m in failure_modes
                        if isinstance(m, dict)
                        and isinstance(m.get("mechanism"), str)
                        and normalize_mechanism(m["mechanism"]) == norm_affected
                    ),
                    None,
                )
                if isinstance(failure_modes, list)
                else None
            )
            if covered is None:
                errors.append(
                    make_error(
                        "WAIVER_REFERENCES_UNKNOWN_MODE",
                        affected_mode_mechanism=affected,
                    )
                )
            elif covered.get("disposition") != "accepted_risk":
                errors.append(
                    make_error(
                        "WAIVER_MODE_DISPOSITION_MISMATCH",
                        affected_mode_mechanism=affected,
                        actual_disposition=covered.get("disposition"),
                    )
                )

    return errors


def derive_status(errors: list[dict[str, Any]]) -> str:
    """Classify the record's status from the error pattern.

    Mirrors the TypeScript validator's status logic but operates only on
    errors detected by this deterministic script:
    - no errors: passed
    - WAIVER_MISSING_FOR_ACCEPTED_RISK only: approval_required (the
      skill is asking for an authorized operator to record the waiver)
    - any other error (or mixed errors): flagged
    """
    if not errors:
        return "passed"
    codes = {e["code"] for e in errors}
    if codes == {"WAIVER_MISSING_FOR_ACCEPTED_RISK"}:
        return "approval_required"
    return "flagged"


def format_summary(summary: dict[str, Any], status: str) -> str:
    """Compact human-readable summary for `passed | flagged | approval_required`."""
    lines = [
        f"status: {status}",
        f"error_count: {summary['error_count']}",
    ]
    if summary["errors"]:
        lines.append("")
        lines.append("errors:")
        for err in summary["errors"]:
            code = err["code"]
            detail = ", ".join(
                f"{k}={v!r}" for k, v in err.items() if k != "code"
            )
            lines.append(f"  - {code}: {detail}" if detail else f"  - {code}")
    return "\n".join(lines)


def make_template_record() -> dict[str, Any]:
    """Print a starter pre-mortem record with placeholder fields."""
    return {
        "schema_version": "1.0.0",
        "expected_outcome": "TODO: what does success look like?",
        "commitment_boundary": "TODO: what is the precise commitment?",
        "applies_to": [
            "TODO: pick from irreversible_action | implementation_commitment | persistent_state_change | public_or_expensive_change | security_privacy_safety_sensitive | difficult_to_verify"
        ],
        "failure_modes": [
            {
                "id": "FM-1",
                "category": "TODO: requirement | evidence | plan | implementation | verification | operational | security | human",
                "mechanism": "TODO: specific failure mechanism (NOT a generic label like 'bugs')",
                "preconditions": "TODO: what conditions must hold for this mode",
                "affected_criterion": "TODO: which acceptance criterion",
                "earliest_warning": "TODO: observable signal",
                "warning_check_status": "TODO: verified | refused | unverified",
                "warning_check_evidence": "TODO: required when status is verified or refused",
                "detection_oracle": "TODO: test or check that catches this",
                "prevention": "TODO: how to prevent",
                "mitigation": "TODO: how to reduce impact when it happens",
                "rollback_recovery": "TODO: required when applies_to includes irreversible_action or persistent_state_change",
                "owner": "TODO: who owns this risk",
                "residual_risk": "TODO: what risk remains after mitigation",
                "disposition": "TODO: open | mitigated | accepted_risk | blocked",
            }
        ],
        "accepted_risks": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic pre-mortem record validator (Sol M1/M2)."
    )
    parser.add_argument(
        "--input",
        type=str,
        help="Path to a JSON file containing the pre-mortem record.",
    )
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read the record from stdin (JSON).",
    )
    parser.add_argument(
        "--format",
        choices=["json", "summary"],
        default="json",
        help="Output format: json (default, machine-readable) or summary (compact text).",
    )
    parser.add_argument(
        "--template",
        action="store_true",
        help="Print a starter pre-mortem record JSON with placeholder fields. Mutually exclusive with --input and --stdin.",
    )
    args = parser.parse_args()

    if args.template:
        print(json.dumps(make_template_record(), indent=2))
        return 0

    if not args.input and not args.stdin:
        print(
            json.dumps(
                make_error(
                    "INVOCATION_ERROR",
                    message="must provide --input <path>, --stdin, or --template",
                )
            )
        )
        return 2

    try:
        if args.stdin:
            record = json.load(sys.stdin)
        else:
            with open(args.input, "r", encoding="utf-8") as f:
                record = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(
            json.dumps(
                make_error(
                    "INVOCATION_ERROR",
                    message=f"failed to read input: {e}",
                )
            )
        )
        return 2

    errors = validate_record(record)
    status = derive_status(errors)
    summary = {
        "schema_version": "1.0.0",
        "status": status,
        "passed": status == "passed",
        "error_count": len(errors),
        "errors": errors,
    }
    if args.format == "summary":
        print(format_summary(summary, status))
    else:
        print(json.dumps(summary, indent=2))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
