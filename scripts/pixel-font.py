#!/usr/bin/env python3
"""Print the pixel-font table that sidebars/agent-status.js draws System 1 labels with.

cmux sidebars can't load a font, so the panel draws its pixel type as rectangles,
like the octopus. The glyphs come from Departure Mono (fonts/, SIL OFL 1.1), drawn
on a grid of 50 units per pixel: at 11 px per em every glyph lands on whole pixels.
Each glyph is 7 px wide and ROWS px tall (from 10 px above the baseline to 3 below),
stored as one string per row with "#" for ink.

    python3 scripts/pixel-font.py            # paste the output over PIXEL_FONT
Needs Pillow.
"""
import os
from PIL import Image, ImageDraw, ImageFont

FONT = os.path.join(os.path.dirname(__file__), "..", "fonts", "DepartureMono-Regular.otf")
CHARS = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    "АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюя"
    " .,:;!?%'’-–—()/+·…▶■"
)
EM, WIDTH, ABOVE, BELOW = 11, 7, 10, 3
ROWS = ABOVE + BELOW


def glyph(font, ch):
    img = Image.new("1", (WIDTH * 2, EM * 2), 0)
    ImageDraw.Draw(img).text((0, ABOVE), ch, font=font, fill=1, anchor="ls")
    return ["".join("#" if img.getpixel((x, y)) else "." for x in range(WIDTH)).rstrip(".")
            for y in range(ROWS)]


def main():
    font = ImageFont.truetype(FONT, EM)
    print("const PIXEL_FONT = {")
    for ch in CHARS:
        rows = glyph(font, ch)
        key = "\\'" if ch == "'" else ch
        print(f"  '{key}': {rows!r},".replace('"', "'") if any(rows) else f"  '{key}': [],")
    print("};")


if __name__ == "__main__":
    main()
