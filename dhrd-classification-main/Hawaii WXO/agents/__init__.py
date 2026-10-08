"""
agents/__init__.py

Local ADK definitions for the Hawaii HRO Classification pipeline agents.
These are READ-ONLY source-of-truth references.
Nothing in this package touches the live Watson Orchestrate instance.

Pipeline flow:
    User
      └─► hro_orchestrate_agent  (entry point — delegates to text_extractor via tool)
            └─► hro_text_extractor_agent  (orchestrator — coordinates extraction pipeline)
                  ├─► hro_pd_agent          (PD .docx → structured JSON)
                  ├─► hro_class_spec_agent  (Class Spec .pdf → structured JSON)
                  └─► hro_classifier_agent  (PD JSON + Class Spec JSON → Analysis prose)

Usage:
    from agents import (
        hro_orchestrate_agent,
        hro_text_extractor_agent,
        hro_pd_agent,
        hro_class_spec_agent,
        hro_classifier_agent,
        ALL_AGENTS,
        AGENT_IDS,
    )

    # Print all live agent IDs
    for name, agent_id in AGENT_IDS.items():
        print(name, agent_id)
"""

from .hro_orchestrate_agent    import agent as hro_orchestrate_agent,    AGENT_ID as _ORCHESTRATE_ID
from .hro_text_extractor_agent import agent as hro_text_extractor_agent, AGENT_ID as _TEXT_EXTRACTOR_ID
from .hro_pd_agent             import agent as hro_pd_agent,             AGENT_ID as _PD_ID
from .hro_class_spec_agent     import agent as hro_class_spec_agent,     AGENT_ID as _CLASS_SPEC_ID
from .hro_classifier_agent     import agent as hro_classifier_agent,     AGENT_ID as _CLASSIFIER_ID

ALL_AGENTS = [
    hro_orchestrate_agent,
    hro_text_extractor_agent,
    hro_pd_agent,
    hro_class_spec_agent,
    hro_classifier_agent,
]

# Live Watson Orchestrate agent IDs — for use with watsonx_orchestrate_client.py
AGENT_IDS = {
    "hro_orchestrate_agent":    _ORCHESTRATE_ID,
    "hro_text_extractor_agent": _TEXT_EXTRACTOR_ID,
    "hro_pd_agent":             _PD_ID,
    "hro_class_spec_agent":     _CLASS_SPEC_ID,
    "hro_classifier_agent":     _CLASSIFIER_ID,
}

__all__ = [
    "hro_orchestrate_agent",
    "hro_text_extractor_agent",
    "hro_pd_agent",
    "hro_class_spec_agent",
    "hro_classifier_agent",
    "ALL_AGENTS",
    "AGENT_IDS",
]
