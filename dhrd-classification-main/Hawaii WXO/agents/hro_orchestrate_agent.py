"""
hro_orchestrate_agent.py
Local ADK definition — read-only reference.
Do NOT call deploy() against the live Watson Orchestrate instance unless intentional.

Live agent ID : bb4adec7-298a-41da-978a-ced9d2620458
Display name  : hro_orchestrate_agent (dev)
"""

from ibm_watsonx_orchestrate.agent_builder.agents import (
    Agent,
    AgentKind,
    AgentStyle,
)

AGENT_ID = "125bd94c-a6b6-4e62-8e74-682902b43e21"  # ca-tor, deployed 2026-10-01

# Tool / flow ID wired to the "Text extractor" skill
TEXT_EXTRACTOR_TOOL_ID = "4172359d-2805-49e4-b13c-c398eb07dc4c"

INSTRUCTIONS = """\
You are the HRO PD Classifier Assistant.

Your only responsibility is to call the Text extractor tool and return its output exactly as received.

## Instructions

1. When invoked  immediately call the Text extractor tool.
2. Do not ask the user for files or file names.
3. Do not inspect, parse, summarize, transform, validate, filter, or modify the tool output.
4. The Text extractor tool handles all file collection and extraction internally.
5. After the Text extractor tool returns, return its complete output exactly as received.
6. Do not add any explanation, commentary, headers, or additional text.
7. Do not call any other agent or tool.
8. If the Text extractor returns an error or empty response, return that response exactly as received.

## Required behavior

User request
→ Call Text extractor
→ Return Text extractor output

The Text extractor output is the final response.

Do not perform any processing after the Text extractor call.\
"""

agent = Agent(
    name="hro_orchestrate_agent",
    display_name="hro_orchestrate_agent (dev)",
    description=(
        "Orchestrates the HRO Position Classification Analysis process by coordinating "
        "Position Description and Class Specification extraction and generating the "
        "final classification analysis."
    ),
    instructions=INSTRUCTIONS,
    llm="groq/openai/gpt-oss-120b",
    style=AgentStyle.REACT_INTRINSIC,
    tools=[TEXT_EXTRACTOR_TOOL_ID],
    collaborators=[],
)
