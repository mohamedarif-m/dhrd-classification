"""Registry sanitization: internal wxO identifiers never leave the process."""

from app.services.registry import client_view, resolve_agent


REG = {"agents": [
    {"key": "jobreq", "wxo_agent_id": "uuid-secret", "wxo_agent_name": "JobReq_C",
     "name": "Job Requisition", "thinking": {"jrc_start": "Loading..."},
     "option_sources": {"job-profiles": {"ttl_s": 43200}}},
    {"key": "other", "wxo_agent_name": "Other_C", "name": "Other"},
]}


def test_client_view_strips_private_keys():
    view = client_view(REG)
    for agent in view["agents"]:
        assert "wxo_agent_id" not in agent
        assert "wxo_agent_name" not in agent
        assert "option_sources" not in agent  # server-side allowlist only
    assert view["agents"][0]["key"] == "jobreq"
    assert view["agents"][0]["thinking"]["jrc_start"] == "Loading..."


def test_client_view_never_contains_id_values():
    import json
    assert "uuid-secret" not in json.dumps(client_view(REG))
    assert "JobReq_C" not in json.dumps(client_view(REG))


def test_client_view_passes_branding_through():
    branding = {"appTitle": "Acme Connect", "logoUrl": "/logo.svg",
                "colors": {"accent": "#ff0000"}}
    view = client_view({**REG, "branding": branding})
    assert view["branding"] == branding
    assert view["agents"][0]["key"] == "jobreq"


def test_client_view_omits_branding_when_absent():
    assert "branding" not in client_view(REG)


def test_shipped_registry_branding_reaches_the_client():
    from pathlib import Path

    from app.services.registry import load_registry

    shipped = load_registry(str(Path(__file__).resolve().parents[1] / "app" / "registry.json"))
    assert client_view(shipped)["branding"]["appTitle"] == "TKO"


def test_resolve_agent_is_allowlist():
    assert resolve_agent(REG, "jobreq")["wxo_agent_name"] == "JobReq_C"
    assert resolve_agent(REG, "not-in-registry") is None
    assert resolve_agent(REG, "") is None
