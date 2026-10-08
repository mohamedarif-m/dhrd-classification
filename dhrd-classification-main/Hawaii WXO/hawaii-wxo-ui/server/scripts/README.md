# scripts

[Back to the proxy](../README.md) | [Back to repo overview](../../../../README.md)

Manual live probes. Neither is imported by the app or the tests.

- `live_driver.py` - headless regression loop: drives a full agent conversation
  through the RUNNING proxy exactly as the browser does. Run from `server/`:
  `.venv/bin/python scripts/live_driver.py warn` (read-only) or `... create`
  (does a REAL create in the dev tenant).
- `capture_stream.py` - one-shot raw capture of a live run's NDJSON stream, for
  pinning event shapes. Reads credentials from `TKO_ENV_FILE`, prints no secrets:
  `TKO_ENV_FILE=/path/to/.env .venv/bin/python scripts/capture_stream.py JobReq_C /tmp/cap.ndjson "hello"`
