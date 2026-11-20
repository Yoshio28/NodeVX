"""Genera assets/icon.ico (y icon.png) para NodeVX. Uso: python3 tools/genicon/genicon.py"""
import os
from PIL import Image, ImageDraw

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "..", "..", "assets")
S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([32, 32, S - 32, S - 32], radius=220, fill=(47, 52, 55, 255))
# Letra "N" geométrica (misma forma que web/favicon.svg, escala 16x)
k = S / 64
pts = [(19, 47), (19, 17), (25, 17), (39, 37), (39, 17), (45, 17), (45, 47), (39, 47), (25, 27), (25, 47)]
d.polygon([(x * k, y * k) for x, y in pts], fill=(255, 255, 255, 255))
# Rayo amarillo pequeño (notas rápidas)
bolt = [(50, 6), (42, 20), (48, 20), (44, 31), (56, 15), (50, 15), (54, 6)]
d.polygon([(x * k, y * k) for x, y in bolt], fill=(250, 204, 21, 255))
img.resize((256, 256), Image.LANCZOS).save(os.path.join(out, "icon.png"))
img.save(os.path.join(out, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ok")
