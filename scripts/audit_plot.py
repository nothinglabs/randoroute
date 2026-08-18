#!/usr/bin/env python3
"""Draw an audited route so a human can judge its shape in one glance.

Companion to scripts/audit_route.mjs. Judging a route from a bare polyline is
genuinely hard -- without a destination, a scale, or a straight-line reference
there is no way to tell a legitimate switchback from a wrong turn. So every
plot carries the same furniture:

  * the crow-flight line from start to destination (grey dashes) -- the thing
    the route is being compared against;
  * start (green ring) and destination (orange square);
  * direction of travel as a blue-to-red colour ramp, so a backtrack shows up
    as a warm segment running back over a cool one;
  * the measured backtrack stretch overdrawn in black, so the metric and the
    picture agree about which part is the problem;
  * a scale bar, because "is that 50 m or 2 km?" changes the verdict.

Usage:
  python3 scripts/audit_plot.py <route.json> [outDir] [--option A]
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

W = H = 900
PAD = 70


def metres_per_degree(lat):
    return 111320.0 * math.cos(math.radians(lat)), 110540.0


def render(result, option, out_path):
    coords = option["coords"]
    frm, to = result["from"], result["to"]
    pts = coords + [frm, to]
    lons = [c[0] for c in pts]
    lats = [c[1] for c in pts]
    mnx, mxx = min(lons), max(lons)
    mny, mxy = min(lats), max(lats)
    # Equal aspect: a route drawn on stretched axes invents bends that the
    # rider will never meet, which is precisely the illusion this is meant to
    # rule out.
    kx, ky = metres_per_degree((mny + mxy) / 2)
    span_x = max((mxx - mnx) * kx, 1.0)
    span_y = max((mxy - mny) * ky, 1.0)
    span = max(span_x, span_y)
    cx_deg, cy_deg = (mnx + mxx) / 2, (mny + mxy) / 2

    def px(lon, lat):
        dx = (lon - cx_deg) * kx
        dy = (lat - cy_deg) * ky
        scale = (W - 2 * PAD) / span
        return (W / 2 + dx * scale, H / 2 - dy * scale)

    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)

    # Crow-flight reference.
    ax, ay = px(*frm)
    bx, by = px(*to)
    steps = 60
    for i in range(steps):
        if i % 2:
            continue
        t0, t1 = i / steps, (i + 1) / steps
        d.line([(ax + (bx - ax) * t0, ay + (by - ay) * t0),
                (ax + (bx - ax) * t1, ay + (by - ay) * t1)],
               fill=(170, 170, 170), width=2)

    screen = [px(*c) for c in coords]
    n = len(screen)
    for i in range(1, n):
        t = i / max(n - 1, 1)
        d.line([screen[i - 1], screen[i]],
               fill=(int(235 * t + 20), 45, int(235 * (1 - t) + 20)), width=5)

    # The measured backtrack, overdrawn so metric and picture cannot disagree.
    m = option["metrics"]
    if m["backtrackM"] >= 50:
        along = [0.0]
        for i in range(1, n):
            kx2, ky2 = metres_per_degree(coords[i][1])
            along.append(along[-1] + math.hypot(
                (coords[i][0] - coords[i - 1][0]) * kx2,
                (coords[i][1] - coords[i - 1][1]) * ky2))
        seg = [screen[i] for i in range(n)
               if m["backtrackAtM"] <= along[i] <= m["backtrackEndM"]]
        if len(seg) > 1:
            d.line(seg, fill=(0, 0, 0), width=2)

    d.ellipse([ax - 11, ay - 11, ax + 11, ay + 11], outline=(0, 150, 60), width=5)
    d.rectangle([bx - 9, by - 9, bx + 9, by + 9], outline=(230, 120, 0), width=5)

    # Scale bar: a round number of metres near a fifth of the frame.
    target = span / 5
    nice = min([1, 2, 5, 10, 20, 50, 100, 200, 500,
                1000, 2000, 5000, 10000, 20000, 50000],
               key=lambda v: abs(v - target))
    bar = nice * (W - 2 * PAD) / span
    d.line([(PAD, H - 34), (PAD + bar, H - 34)], fill="black", width=4)
    label = f"{nice} m" if nice < 1000 else f"{nice // 1000} km"
    d.text((PAD, H - 28), label, fill="black")

    head = (f'{result["id"]} {option["letter"]}'
            f'{"*" if option.get("recommended") else ""}  '
            f'{m["lengthM"] / 1609:.1f}mi  crow {m["crowM"] / 1609:.1f}mi  '
            f'x{m["detourFactor"]}')
    d.text((PAD, 22), head, fill="black")
    d.text((PAD, 38),
           f'backtrack {m["backtrackM"]}m  self-touch {m["selfTouchM"]}  '
           f'reversals {m["reversals"]}', fill="black")
    if option.get("flags"):
        d.text((PAD, 54), "FLAGS: " + ", ".join(option["flags"]), fill=(200, 0, 0))
    d.text((PAD, H - 52), result.get("name", ""), fill=(80, 80, 80))

    img.save(out_path)
    return out_path


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    want = None
    for a in sys.argv[1:]:
        if a.startswith("--option"):
            want = a.split("=", 1)[1] if "=" in a else None
    src = Path(args[0])
    out_dir = Path(args[1]) if len(args) > 1 else src.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    result = json.loads(src.read_text())
    if not result.get("ok"):
        print(f'{result["id"]}: no route ({result.get("reason")})')
        return
    written = []
    for option in result["options"]:
        if want and option["letter"] != want:
            continue
        name = f'{result["id"]}_{option["letter"].replace(" ", "")}.png'
        written.append(str(render(result, option, out_dir / name)))
    print("\n".join(written))


if __name__ == "__main__":
    main()
