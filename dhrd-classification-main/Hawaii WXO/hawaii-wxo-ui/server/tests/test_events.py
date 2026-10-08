"""Sanitization and message slimming against the live-captured shapes."""

import json

from app.services.events import (CONTRACT_META_KEY, _meta_block,
                                 extract_meta_key, sanitize, slim_message)


def test_sanitize_drops_internal_ids_recursively():
    event = {
        "run_id": "r1", "agent_id": "secret-agent-uuid", "thread_id": "t1",
        "context": {"wxo_tenant_id": "tenant"},
        "message": {"tenant_id": "tenant", "created_by": "iam-ServiceId-x",
                    "content": [{"text": "hi"}]},
    }
    out = sanitize(event)
    dumped = json.dumps(out)
    assert "secret-agent-uuid" not in dumped
    assert "tenant" not in dumped
    assert "iam-ServiceId" not in dumped
    assert out["run_id"] == "r1" and out["thread_id"] == "t1"
    assert out["message"]["content"][0]["text"] == "hi"


def _live_shaped_message(meta_key):
    tool_payload = json.dumps({
        "_meta": {meta_key: {"response_type": "forms", "name": "form_x"}},
        "content": [{"type": "text", "text": "form ready"}],
    })
    return {
        "id": "m1", "role": "assistant", "created_on": "2026-07-30T23:02:56Z",
        "tenant_id": "secret", "created_by": "iam-x",
        "content": [{"response_type": "text", "id": "1", "text": "Here is the form"}],
        "additional_properties": {"display_properties": {"is_async": False}},
        "step_history": [
            {"step_details": [{"type": "tool_calls",
                               "tool_calls": [{"name": "jrc_widget_start", "args": {}}],
                               "agent_display_name": "Job Requisition (Custom UI)"}]},
            {"step_details": [{"type": "tool_response", "name": "jrc_widget_start",
                               "content": tool_payload}]},
        ],
    }


def test_slim_message_extracts_text_tools_and_contract_meta():
    slim = slim_message(_live_shaped_message(CONTRACT_META_KEY))
    assert slim["text"] == "Here is the form"
    assert slim["tools_called"] == ["jrc_widget_start"]
    assert slim["meta"][CONTRACT_META_KEY]["name"] == "form_x"
    assert slim["is_async"] is False
    assert "tenant_id" not in json.dumps(slim)


def test_slim_message_ignores_legacy_widget_meta():
    slim = slim_message(_live_shaped_message("com.ibm.orchestrate/widget"))
    assert slim["meta"] is None


def test_extract_meta_key_returns_the_value_contract_returns_the_block():
    details = _live_shaped_message(CONTRACT_META_KEY)["step_history"][1]["step_details"]
    assert _meta_block(details, CONTRACT_META_KEY)[CONTRACT_META_KEY]["name"] == "form_x"
    assert extract_meta_key(details, CONTRACT_META_KEY)["name"] == "form_x"
    assert extract_meta_key(details, "tko/options-dump@v1") is None

    dump = [{"type": "tool_response", "name": "jrc_options_dump",
             "content": json.dumps({"_meta": {"tko/options-dump@v1": {
                 "source": "sup-orgs", "page": 1, "pages": 1, "total": 1,
                 "rows": [{"key": "k", "cells": ["c"]}]}}})}]
    assert extract_meta_key(dump, "tko/options-dump@v1")["source"] == "sup-orgs"
    assert _meta_block(dump, CONTRACT_META_KEY) is None


def test_slim_message_handles_string_content_and_no_steps():
    slim = slim_message({"id": "m2", "role": "user", "content": "plain text"})
    assert slim["text"] == "plain text"
    assert slim["tools_called"] == []
    assert slim["meta"] is None


def test_slim_message_surfaces_receipt_only_meta():
    # A submit turn's tool_response _meta carries ONLY the receipt key; the
    # slimmed message must still surface it (reload receipt cards).
    receipt = {"created": True, "status": "created", "id": "R0001",
               "rows": [{"label": "Title", "value": "X"}]}
    content = json.dumps({"content": [{"type": "text", "text": "done"}],
                          "_meta": {"tko/receipt@v1": receipt}})
    msg = {"id": "m1", "role": "assistant", "created_on": "t",
           "content": [{"response_type": "text", "text": "short line"}],
           "step_history": [{"step_details": [
               {"type": "tool_response", "content": content}]}]}
    slim = slim_message(msg)
    assert slim["meta"] == {"tko/receipt@v1": receipt}
