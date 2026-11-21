"""Generate the iOS app icon and splash image in resources/.

Run: python tools/make-app-assets.py
Requires Pillow. The PNGs it writes are committed, so CI needs no Python.

The mark: a radar sweep over a dark navy gradient, drawn at 4x and downsampled
for clean edges. iOS applies its own rounded-corner mask to icon.png, so the
artwork is full-bleed.
"""

from math import cos, radians, sin
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "resources"
NAVY_TOP = (11, 18, 32)
NAVY_BOTTOM = (17, 34, 64)
ACCENT = (96, 165, 250)
ACCENT_BRIGHT = (147, 197, 253)


def gradient(size, top, bottom):
    image = Image.new("RGB", (1, size), top)
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.point((0, y), fill=color)
    return image.resize((size, size), Image.BILINEAR)


def radar(size, scale=4.0):
    """The radar mark as an RGBA tile of `size` x `size` pixels."""
    s = int(size * scale)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    cx = cy = s / 2

    # Sweep first: stacked wedges, dimmer as the angle lags behind the leading
    # edge. Rings are drawn over it so the sectors read as inside the dish.
    sweep = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sweep_draw = ImageDraw.Draw(sweep, "RGBA")
    start = -132
    for index in range(22):
        angle = start + index * 2.8
        alpha = 10 + index * 6
        r = s * 0.33
        sweep_draw.pieslice(
            (cx - r, cy - r, cx + r, cy + r),
            start=angle,
            end=angle + 3.2,
            fill=(*ACCENT_BRIGHT, alpha),
        )
    sweep = sweep.filter(ImageFilter.GaussianBlur(radius=s * 0.004))
    canvas = Image.alpha_composite(canvas, sweep)

    draw = ImageDraw.Draw(canvas, "RGBA")

    # Rings.
    for radius_frac, width_frac, alpha in ((0.13, 0.012, 165), (0.23, 0.010, 120), (0.33, 0.009, 80)):
        r = s * radius_frac
        w = max(2, int(s * width_frac))
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(*ACCENT, alpha), width=w)

    # Crosshair spokes.
    for angle in (0, 90, 180, 270):
        a = radians(angle)
        r1, r2 = s * 0.13, s * 0.33
        draw.line(
            (cx + r1 * cos(a), cy + r1 * sin(a), cx + r2 * cos(a), cy + r2 * sin(a)),
            fill=(*ACCENT, 60),
            width=max(2, int(s * 0.006)),
        )

    # Leading edge line and blips on top of the rings.
    a = radians(start)
    r = s * 0.33
    draw.line((cx, cy, cx + r * cos(a), cy + r * sin(a)), fill=(*ACCENT_BRIGHT, 230), width=max(3, int(s * 0.009)))

    for angle, dist, radius_frac in ((-104, 0.27, 0.013), (-160, 0.19, 0.010), (-58, 0.24, 0.009)):
        t = radians(angle)
        px, py = cx + s * dist * cos(t), cy + s * dist * sin(t)
        br = s * radius_frac
        draw.ellipse((px - br, py - br, px + br, py + br), fill=(*ACCENT_BRIGHT, 240))

    # Core.
    core = s * 0.028
    draw.ellipse((cx - core, cy - core, cx + core, cy + core), fill=(*ACCENT_BRIGHT, 255))

    return canvas.resize((size, size), Image.LANCZOS)


def make_icon(size=1024):
    base = gradient(size, NAVY_TOP, NAVY_BOTTOM).convert("RGBA")
    mark = radar(int(size * 0.95), scale=4.0)
    offset = ((size - mark.width) // 2, (size - mark.height) // 2)
    base.alpha_composite(mark, offset)
    base.convert("RGB").save(OUT / "icon.png", "PNG", optimize=True)


def make_splash(size=2732):
    base = gradient(size, NAVY_TOP, NAVY_BOTTOM).convert("RGBA")
    mark = radar(int(size * 0.22), scale=3.0)
    offset = ((size - mark.width) // 2, int(size * 0.33))
    base.alpha_composite(mark, offset)
    base.convert("RGB").save(OUT / "splash.png", "PNG", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    make_icon()
    make_splash()
    print("wrote", OUT / "icon.png", OUT / "splash.png")
