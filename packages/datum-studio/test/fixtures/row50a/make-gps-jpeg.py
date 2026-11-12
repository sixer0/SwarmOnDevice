"""Row 50a (1.2.6, W-13 SEC-10): writes gps-1x1.jpg, a synthetic 1x1 grey JPEG
whose EXIF carries a GPS IFD with made-up coordinates (1 N, 2 E). Not a photo,
no real place or person. Regenerate: python3 make-gps-jpeg.py (Pillow)."""
from pathlib import Path
from PIL import Image

img = Image.new("RGB", (1, 1), (128, 128, 128))
exif = Image.Exif()
exif[0x0131] = "row50a-fixture"  # Software
exif.get_ifd(0x8825).update({1: "N", 2: (1.0, 0.0, 0.0), 3: "E", 4: (2.0, 0.0, 0.0)})
out = Path(__file__).with_name("gps-1x1.jpg")
img.save(out, "JPEG", quality=90, exif=exif.tobytes())
print(out, out.stat().st_size)
