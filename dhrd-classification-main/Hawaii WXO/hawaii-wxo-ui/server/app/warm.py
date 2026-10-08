"""Compatibility shim: the cache warmer now lives in app/jobs/warm.py.

The Code Engine job runs `python3 -m app.warm` verbatim, so this module stays
put and re-exports the job's entry point. Do not delete it without changing the
job command first.
"""

import sys

from .jobs.warm import main

__all__ = ["main"]

if __name__ == "__main__":
    sys.exit(main())
