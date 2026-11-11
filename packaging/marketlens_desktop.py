"""Entry point PyInstaller freezes into MarketLens.app / MarketLens.exe / the Linux program."""
import sys

from marketlens.desktop import main

if __name__ == "__main__":
    sys.exit(main())
