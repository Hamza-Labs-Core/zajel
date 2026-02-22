"""Entry point for python -m zajel.cli.

Routes to daemon or client based on the first argument:
    python -m zajel.cli daemon --signaling-url wss://... --name bob
    python -m zajel.cli status
    python -m zajel.cli send-text --peer-id ABC "Hello!"
"""

import sys


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "daemon":
        from .daemon import main as daemon_main
        daemon_main(sys.argv[2:])
    else:
        from .client import main as client_main
        client_main(sys.argv[1:])


if __name__ == "__main__":
    main()
