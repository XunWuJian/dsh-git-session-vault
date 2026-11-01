"""Generate the plugin icon: two stacked session logs joined by a sync arrow.

Drawn at 4x and downsampled so the rounded corners and strokes stay clean at
the 256 px size the marketplace grid expects.
"""
from PIL import Image, ImageDraw

SIZE = 1024
SCALE = 4
CANVAS = SIZE * SCALE // 4 * 4  # keep it a round number
W = SIZE

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)


def rounded(box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


# Background: deep indigo gradient, drawn as horizontal bands.
top = (37, 52, 122)
bottom = (22, 30, 74)
for y in range(W):
    ratio = y / (W - 1)
    color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
    draw.line([(0, y), (W, y)], fill=color + (255,))

# Re-mask the gradient into a rounded square.
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=255)
plate = Image.new("RGBA", (W, W), (0, 0, 0, 0))
plate.paste(img, (0, 0), mask)
img = plate
draw = ImageDraw.Draw(img)

# Two session "cards" offset diagonally: local at the back, remote at the front.
back = [int(W * 0.17), int(W * 0.20), int(W * 0.63), int(W * 0.55)]
front = [int(W * 0.36), int(W * 0.44), int(W * 0.83), int(W * 0.79)]
rounded(back, int(W * 0.07), (99, 132, 255, 120))
rounded(front, int(W * 0.07), (255, 255, 255, 245))

# Log lines on the front card.
line_color = (48, 66, 140, 255)
line_x0 = front[0] + int(W * 0.06)
line_x1 = front[2] - int(W * 0.06)
for index, width_ratio in enumerate((1.0, 0.72, 0.88)):
    y = front[1] + int(W * 0.09) + index * int(W * 0.075)
    draw.rounded_rectangle(
        [line_x0, y, line_x0 + int((line_x1 - line_x0) * width_ratio), y + int(W * 0.028)],
        radius=int(W * 0.014),
        fill=line_color,
    )

# A circular sync arrow in the lower left, overlapping both cards.
cx, cy, r = int(W * 0.29), int(W * 0.76), int(W * 0.135)
draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(34, 197, 94, 255))
arrow = (255, 255, 255, 255)
# Two opposing chevrons suggest a two-way exchange.
draw.polygon(
    [
        (cx - int(r * 0.52), cy - int(r * 0.10)),
        (cx + int(r * 0.10), cy - int(r * 0.10)),
        (cx + int(r * 0.10), cy - int(r * 0.34)),
        (cx + int(r * 0.60), cy),
        (cx + int(r * 0.10), cy + int(r * 0.34)),
        (cx + int(r * 0.10), cy + int(r * 0.10)),
        (cx - int(r * 0.52), cy + int(r * 0.10)),
    ],
    fill=arrow,
)

img = img.resize((256, 256), Image.LANCZOS)
img.save(r"E:\temp\ds-test\dsh-session-vault\assets\icon.png", "PNG", optimize=True)
print("wrote assets/icon.png", img.size)
