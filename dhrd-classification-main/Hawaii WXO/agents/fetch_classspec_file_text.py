"""
HRO Class Spec Pipeline — File Upload Text Extractor Tool

Accepts a Class Specification PDF uploaded directly in the WatsonX Orchestrate
chat interface. The platform converts the upload to a presigned S3 URL pointing
to a JSON envelope with a "text" field. This tool fetches that JSON and returns
the plain-text body, ready for the agent to parse into structured JSON.

Functionally identical to fetch_classspec_text but surfaces a PDF upload widget
so the agent can prompt the user to upload the file directly.
"""

import json
import requests
from typing import Annotated

from ibm_watsonx_orchestrate.agent_builder.tools import tool, WXOFile, MultiFileConstraints


@tool
def fetch_classspec_file_text(
    pdf_file: Annotated[
        WXOFile,
        MultiFileConstraints(
            min_files=1,
            max_files=1,
            accepted_file_extensions=["pdf"],
            text="Upload the Class Specification PDF",
        ),
    ],
) -> str:
    """
    Extract the full plain-text content from an uploaded Class Specification PDF.

    Accepts a single PDF uploaded directly in the chat interface. The platform
    processes the upload and provides a presigned S3 URL to a JSON extraction
    envelope containing a "text" field with the document's plain text.

    Args:
        pdf_file: The Class Specification PDF file uploaded by the user.

    Returns:
        str: The plain text content of the document. On error, returns a
             JSON-encoded error string.
    """
    try:
        url = str(pdf_file)

        response = requests.get(url, timeout=60)
        response.raise_for_status()

        try:
            data = response.json()
        except Exception:
            # Not JSON — return raw text as-is (e.g. plain text extraction)
            return response.text

        text = data.get("text")
        if text:
            return text

        # "text" field absent — return everything except heavy structure fields
        slim = {k: v for k, v in data.items() if k not in ("all_structures", "pages_metadata")}
        return json.dumps(slim)

    except requests.HTTPError as exc:
        return json.dumps({"error": "HTTPError", "detail": str(exc)})
    except requests.RequestException as exc:
        return json.dumps({"error": "RequestException", "detail": str(exc)})
    except Exception as exc:
        return json.dumps({"error": type(exc).__name__, "detail": str(exc)})
