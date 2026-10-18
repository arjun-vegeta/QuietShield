# Draws the QuietShield icon (shield with a "hush" mark) at 1024px and downsamples.
import sys
from PIL import Image, ImageDraw

S = 1024
def shield_points(cx, top, w, h):
    # Classic shield: flat-ish top with rounded shoulders, tapering to a point.
    pts = []
    import math
    for i in range(0, 101):
        t = i / 100
        # right edge from top-right shoulder down to bottom point
        x = cx + (w / 2) * (1 - t ** 2.2)
        y = top + h * 0.12 + (h * 0.88) * t
        pts.append((x, y))
    left = [(2 * cx - x, y) for (x, y) in reversed(pts)]
    # top edge with a gentle dip in the middle
    top_edge = []
    for i in range(0, 41):
        t = i / 40
        x = cx - w / 2 + w * t
        y = top + h * 0.12 - h * 0.12 * (1 - abs(2 * t - 1)) * 0.0 - h * 0.06 * math.sin(math.pi * t)
        top_edge.append((x, y))
    return top_edge + pts + left

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
# gradient fill via mask
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    r = int(52 + (31 - 52) * t); g = int(84 + (40 - 84) * t); b = int(222 + (140 - 222) * t)
    gd.line([(0, y), (S, y)], fill=(r, g, b, 255))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).polygon(shield_points(S / 2, 70, 820, 900), fill=255)
img.paste(grad, (0, 0), mask)
# inner highlight edge
inner = Image.new('L', (S, S), 0)
ImageDraw.Draw(inner).polygon(shield_points(S / 2, 140, 660, 740), fill=255)
hl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
hl.paste(Image.new('RGBA', (S, S), (255, 255, 255, 34)), (0, 0), inner)
img = Image.alpha_composite(img, hl)
d = ImageDraw.Draw(img)
# "quiet" mark: three soft horizontal bars of decreasing width (sound fading out)
for i, (w, y) in enumerate([(420, 380), (300, 500), (180, 620)]):
    bar = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bar).rounded_rectangle([S / 2 - w / 2, y, S / 2 + w / 2, y + 64], radius=32, fill=(255, 255, 255, 255 - i * 60))
    img = Image.alpha_composite(img, bar)

out = sys.argv[1]
for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f'{out}/icon-{size}.png')
img.resize((512, 512), Image.LANCZOS).save(f'{out}/icon-512.png')
