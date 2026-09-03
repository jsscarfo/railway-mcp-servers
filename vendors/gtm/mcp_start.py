"""MCP spawn wrapper for Cursor on Windows.

Cursor does not reliably respect the ``cwd`` field in ``.cursor/mcp.json``
for stdio MCP servers. This wrapper:
1. Changes into this package directory so relative paths resolve correctly.
2. Injects the Windows native TLS trust store for Google API calls.
3. Runs fastmcp_gtm_server.py (real GTM API tools, not the chatters demo).
"""

from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    try:
        import truststore
        truststore.inject_into_ssl()
    except Exception:
        pass

    os.chdir(SERVER_DIR)
    if str(SERVER_DIR) not in sys.path:
        sys.path.insert(0, str(SERVER_DIR))

    runpy.run_path(str(SERVER_DIR / "fastmcp_gtm_server.py"), run_name="__main__")


if __name__ == "__main__":
    main()
