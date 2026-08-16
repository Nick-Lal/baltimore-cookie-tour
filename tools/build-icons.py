"""
Generates the app icons.

    python tools/build-icons.py

Committed rather than hand-drawn so the icons can be regenerated if the palette
changes. iOS ignores SVG favicons for Add to Home Screen and wants a real PNG,
which is why these exist at all.

The chip positions are fixed rather than random: a random layout regenerates
differently every run, which makes the diff noisy and the icon subtly unstable
across sizes.
"""

from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (46, 32, 25)          # --label from Bake Sale, the darkest brand brown
DOUGH = (226, 184, 120)    # baked cookie
DOUGH_EDGE = (198, 152, 92)
CHIP = (58, 36, 22)

# unit-circle positions, radius as a fraction of the cookie radius
CHIPS = [
    (-0.34, -0.30, 0.15), (0.22, -0.40, 0.13), (0.46, 0.06, 0.12),
    (-0.10, 0.02, 0.16),  (-0.44, 0.28, 0.12), (0.14, 0.42, 0.14),
    (0.40, -0.44, 0.09),  (-0.02, -0.56, 0.10), (-0.56, -0.04, 0.10),
    (0.30, 0.34, 0.09),
]


def draw(size: int, *, maskable: bool = False, transparent: bool = False) -> Image.Image:
    # 4x supersample, then downscale. Cheaper than antialiasing by hand.
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if not transparent:
        if maskable:
            d.rectangle([0, 0, s, s], fill=BG)
        else:
            d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)

    # Maskable icons must keep their content inside the safe zone, because the
    # launcher is free to crop to a circle.
    cookie_r = s * (0.30 if maskable else 0.36)
    cx = cy = s / 2

    d.ellipse([cx - cookie_r, cy - cookie_r, cx + cookie_r, cy + cookie_r],
              fill=DOUGH, outline=DOUGH_EDGE, width=max(1, int(s * 0.012)))

    for ux, uy, ur in CHIPS:
        chx, chy = cx + ux * cookie_r, cy + uy * cookie_r
        chr_ = ur * cookie_r
        d.ellipse([chx - chr_, chy - chr_, chx + chr_, chy + chr_], fill=CHIP)

    # a bite, so it reads as eaten rather than as a generic circle
    bite_r = cookie_r * 0.42
    bx, by = cx + cookie_r * 0.78, cy - cookie_r * 0.72
    d.ellipse([bx - bite_r, by - bite_r, bx + bite_r, by + bite_r],
              fill=(0, 0, 0, 0) if transparent else BG)

    return img.resize((size, size), Image.LANCZOS)


made = []
for size in (180, 192, 512):
    p = OUT / f"icon-{size}.png"
    draw(size).save(p, optimize=True)
    made.append(p.name)

p = OUT / "icon-maskable-512.png"
draw(512, maskable=True).save(p, optimize=True)
made.append(p.name)

p = OUT / "favicon-32.png"
draw(32).save(p, optimize=True)
made.append(p.name)

print("wrote", ", ".join(made), "->", OUT)
