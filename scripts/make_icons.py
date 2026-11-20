"""Erzeugt die App-Symbole (Springer auf goldenem Grund)."""
from PIL import Image, ImageDraw, ImageFont
for size in (192, 512):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(226, 165, 74, 255))
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', int(size * 0.72))
    glyph = '♞'
    bbox = d.textbbox((0, 0), glyph, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), glyph, font=font, fill=(29, 20, 7, 255))
    img.save(f'public/icons/icon-{size}.png')
print('ok')
