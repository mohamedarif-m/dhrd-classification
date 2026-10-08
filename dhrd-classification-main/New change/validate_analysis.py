#!/usr/bin/env python3
"""Deterministic checks for the HRO v2.1 Analysis output contract."""
from __future__ import annotations
import argparse, json, re
from pathlib import Path

HEADING = re.compile(r"^\*\*(?P<title>.+?)(?:, Job Code: (?P<code>[^*]+?))? – (?P<det>Appropriate(?: \(Closest Fit\))?|Not Appropriate)\*\*$")
TYPE_HEADING = re.compile(r"^\*\*(?P<title>.+?)(?:, Job Code: (?P<code>[^*]+?))? \(Type (?P<num>\d+)(?:: (?P<name>[^)]+))?\) – (?P<det>Appropriate|Not Appropriate)\*\*$")
TAKEN = "Taken together,"
FORBIDDEN = ("[, SR-XX", "BU-XX", "[XXXX]", "Not provided", "N/A")

def words(s: str) -> int:
    return len(re.findall(r"\b[\w’'-]+\b", s, flags=re.UNICODE))

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("draft", type=Path)
    ap.add_argument("--manifest", type=Path)
    args = ap.parse_args()
    text = args.draft.read_text(encoding="utf-8")
    errors = []
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    if not lines or lines[0] != "**Analysis:":
        errors.append("output must begin exactly with **Analysis:**")
    if text.count(TAKEN) == 0:
        errors.append("no Taken together closing found")
    if text.count(TAKEN) > 20:
        errors.append("unexpectedly many Taken together closings")
    for marker in FORBIDDEN:
        if marker in text:
            errors.append(f"placeholder or forbidden marker remains: {marker}")
    for phrase in ("whereas", "the main distinction is", "reaches beyond"):
        if phrase.lower() in text.lower():
            errors.append(f"forbidden comparative phrase: {phrase}")
    if text.lower().count("exceeds") > 1:
        errors.append("exceeds appears more than once; it belongs only in Below closing")
    class_spans, type_matches = [], []
    for i, line in enumerate(lines):
        m = TYPE_HEADING.match(line)
        if m:
            type_matches.append(m)
            continue
        m = HEADING.match(line)
        if m:
            class_spans.append((i, m))
        elif line.startswith("**") and line.endswith("**"):
            errors.append(f"unrecognized bold heading: {line}")
    if not class_spans:
        errors.append("no class heading found")
    else:
        for pos, (start, m) in enumerate(class_spans):
            end = class_spans[pos + 1][0] if pos + 1 < len(class_spans) else len(lines)
            body = "\n".join(lines[start + 1:end])
            if body.count(TAKEN) != 1:
                errors.append(f"{m.group('title')}: expected exactly one class closing")
            if words(body) > 700:
                errors.append(f"{m.group('title')}: section exceeds 700-word safety ceiling")
            if m.group("det") == "Appropriate" and pos != len(class_spans) - 1:
                errors.append(f"{m.group('title')}: Appropriate class must be final class section")
    if args.manifest:
        try:
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            if manifest.get("status") != "READY":
                errors.append("decision record is not READY")
            expected = manifest.get("heading_sequence") or []
            actual = [line for line in lines if HEADING.match(line) or TYPE_HEADING.match(line)]
            if expected and actual != expected:
                errors.append("draft headings do not exactly match decision_record.heading_sequence")
            for key, value in manifest.get("readiness_checks", {}).items():
                if value is not True:
                    errors.append(f"decision readiness check is false: {key}")
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"cannot read manifest: {exc}")
    result = {"passed": not errors, "errors": errors, "class_headings": len(class_spans), "type_headings": len(type_matches), "word_count": words(text)}
    print(json.dumps(result, indent=2))
    return 0 if not errors else 1

if __name__ == "__main__":
    raise SystemExit(main())
