# HRO v2.1 solution

This is the usable replacement for the earlier addenda. It keeps the client-facing v2 report shape and puts classification truth before prose.

Use the files in this order:

1. Run 01_EVIDENCE_GATE.txt with the normalized PD and complete class-specification extractions, plus original documents when available. The gate must produce status READY. HOLD is a stop: repair the extraction, source mapping, or decision record before writing.
2. Pass the READY decision record, normalized inputs, and exact heading_sequence to 02_ANALYSIS_WRITER.txt. This produces only the Analysis section and preserves the v2 headings, class order, type headings, client-style openers, closing sentences, word limits, and pricing conditions.
3. Run validate_analysis.py for mechanical checks. If a READY decision record is available, pass it with --manifest so headings and readiness checks are bound to the approved record.
4. Run 03_SOURCE_AND_STYLE_REVIEW.txt in a separate review call against the source documents and draft. Release only when all four check fields are PASS and findings is empty.

The validator is intentionally limited. It catches missing headings, missing class closings, placeholders, wrong heading sequence, false readiness, and some forbidden phrasing. It cannot prove that a sentence is supported by a PD or class specification. That is why the independent source review remains mandatory.

The Accountant sample is a regression fixture for this workflow. The source review must reject it for at least these verified defects: Accountant III is printed with job code 2.311 even though the class source maps 2.311 to Accountant I; no separate type headings/evaluations are supplied for the three types; Accountant IV declares Operations appropriate without evaluating Systems and Fund Control; its supervision statement conflicts with the specification and asserts no staff without affirmative PD evidence; Accountant V's parent generalizes requirements across distinct types; and the pricing line contains placeholders. The workflow must not repair these with prose.

The prompts do not guarantee a correct classification by themselves. They establish a release gate that makes unsupported decisions and format failures visible. That is the appropriate reliability claim until the workflow is run against a representative evaluation set.
