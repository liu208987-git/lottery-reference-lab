"""Build the README demo GIF from real IOI-LottoLab screenshots."""

from __future__ import annotations

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
SOURCES = [
    ASSETS / "dashboard-overview.png",
    ASSETS / "live-forecast.png",
    ASSETS / "dlt-forecast.png",
]
OUTPUT = ASSETS / "demo.gif"


def normalized(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    canvas = Image.new("RGB", size, "#07101f")
    frame = image.convert("RGB")
    frame.thumbnail(size, Image.Resampling.LANCZOS)
    left = (size[0] - frame.width) // 2
    top = (size[1] - frame.height) // 2
    canvas.paste(frame, (left, top))
    return canvas


def main() -> None:
    images = [Image.open(path) for path in SOURCES]
    size = (960, 542)
    slides = [normalized(image, size) for image in images]
    frames: list[Image.Image] = []
    durations: list[int] = []

    for index, current in enumerate(slides):
        following = slides[(index + 1) % len(slides)]
        frames.extend([current] * 12)
        durations.extend([100] * 12)
        for step in range(1, 9):
            frames.append(Image.blend(current, following, step / 9))
            durations.append(70)

    palette_frames = [
        frame.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
        for frame in frames
    ]
    palette_frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=palette_frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"Created {OUTPUT}")


if __name__ == "__main__":
    main()
