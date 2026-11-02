# Usage : python tools/favicon.py public/favicon.ico <apercu-16px-agrandi.png> public/apple-touch-icon.png
# Rend la nacelle en .ico (16, 32, 48) : dessinee a 256 px puis reduite.
# Le 16 px perd le fanion et epaissit le mat, sinon il ne reste qu'un trait flou.
from PIL import Image, ImageDraw
S = 256 / 64

def quad(p0, c, p1, n=24):
    return [((1-t)**2*p0[0]+2*(1-t)*t*c[0]+t*t*p1[0], (1-t)**2*p0[1]+2*(1-t)*t*c[1]+t*t*p1[1]) for t in (i/n for i in range(n+1))]

def render(small):
    img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sc = lambda pts: [(x*S, y*S) for x, y in pts]
    d.rectangle([0, 0, 256, 256], fill='#0e2233')
    d.rectangle([0, 46*S, 256, 256], fill='#1f78c8')
    d.polygon(sc(quad((4,47),(14,34),(26,47))), fill='#3fb950')
    d.polygon(sc(quad((40,47),(51,32),(61,47))), fill='#3fb950')
    if small:
        d.rectangle(sc([(28.5,16),(35.5,50)]), fill='#e8f1f8')
        d.polygon(sc([(17,10),(47,10),(42,26),(22,26)]), fill='#f2c14e')
    else:
        d.rounded_rectangle(sc([(30,16),(34,50)]), radius=S, fill='#e8f1f8')
        d.polygon(sc([(20,13),(44,13),(40,25),(24,25)]), fill='#f2c14e')
        d.line(sc([(32,4),(32,13)]), fill='#e8f1f8', width=int(2.5*S))
        d.line(sc([(32,5),(41,8),(32,11)]), fill='#e8f1f8', width=int(2.5*S), joint='curve')
    mask = Image.new('L', (256, 256), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 255, 255], radius=int(14*S), fill=255)
    img.putalpha(mask)
    return img

import sys
big, small = render(False), render(True)
frames = [small.resize((16,16), Image.LANCZOS), small.resize((32,32), Image.LANCZOS), small.resize((48,48), Image.LANCZOS)]
frames[2].save(sys.argv[1], format='ICO', sizes=[(16,16),(32,32),(48,48)], append_images=frames[:2])
small.resize((16,16), Image.LANCZOS).resize((128,128), Image.NEAREST).save(sys.argv[2])
big.resize((180,180), Image.LANCZOS).save(sys.argv[3])
