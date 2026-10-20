"""Assemble the README slideshow from unchanged browser captures. Requires Pillow.

Run: python3 scripts/render-readme-tour.py
An optional first argument selects a different repository root.
"""

import json
import sys
from pathlib import Path

from PIL import Image


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    assets = root / "docs" / "assets" / "demo"
    tour = json.loads((assets / "tour.json").read_text(encoding="utf-8"))
    frames = []
    for scene in tour["frames"]:
        with Image.open(assets / scene["file"]) as source:
            frames.append(source.convert("RGB"))
    if not frames or any(frame.size != frames[0].size for frame in frames):
        raise ValueError("Tour frames must have matching dimensions")
    output = assets / tour["output"]
    frames[0].save(
        output,
        save_all=True,
        append_images=frames[1:],
        duration=[scene["durationMs"] for scene in tour["frames"]],
        loop=0,
        optimize=True,
        disposal=2,
    )
    with Image.open(output) as result:
        assert result.n_frames == len(frames)
        assert result.size == frames[0].size
        assert result.info["loop"] == 0
    print(f"Saved {len(frames)} frames to {output.name} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
