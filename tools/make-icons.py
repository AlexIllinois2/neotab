#!/usr/bin/env python3
"""Generate the extension PNG icons from the hand-drawn SVG source.

Only used when the artwork changes; the generated PNGs are committed so the
extension has no build step. Requires Pillow and either cairosvg or ImageMagick.
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "icons" / "logo.svg"
OUT = ROOT / "icons"


def main() -> int:
    if shutil.which("magick") or shutil.which("convert"):
        tool = "magick" if shutil.which("magick") else "convert"
        for size in (16, 48, 128):
            subprocess.run(
                [tool, "-background", "none", str(SVG), "-resize", f"{size}x{size}",
                 str(OUT / f"icon-{size}.png")],
                check=True,
            )
    else:
        try:
            import cairosvg  # type: ignore
        except ImportError:
            print("need ImageMagick or cairosvg", file=sys.stderr)
            return 1
        for size in (16, 48, 128):
            cairosvg.svg2png(
                url=str(SVG), write_to=str(OUT / f"icon-{size}.png"),
                output_width=size, output_height=size,
            )
    print("icons written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
