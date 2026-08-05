from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1] / "public"


def lerp(start: int, end: int, amount: float) -> int:
    return round(start + (end - start) * amount)


def emerald_gradient(size: int) -> Image.Image:
    top = (43, 212, 155, 255)
    bottom = (7, 132, 91, 255)
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        amount = y / max(1, size - 1)
        color = tuple(lerp(top[index], bottom[index], amount) for index in range(4))
        draw.line((0, y, size, y), fill=color)
    return image


def render_icon(size: int, *, maskable: bool = False) -> Image.Image:
    scale = 4
    canvas_size = size * scale
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))

    if maskable:
        canvas.alpha_composite(emerald_gradient(canvas_size))
        inset = 0
        radius = 0
        content_scale = 0.74
    else:
        inset = round(canvas_size * 0.035)
        radius = round(canvas_size * 0.265)
        content_scale = 1
        gradient = emerald_gradient(canvas_size - inset * 2)
        mask = Image.new("L", gradient.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, gradient.width - 1, gradient.height - 1),
            radius=radius,
            fill=255,
        )
        canvas.alpha_composite(Image.composite(gradient, Image.new("RGBA", gradient.size), mask), (inset, inset))

    center = canvas_size / 2
    safe = canvas_size * content_scale
    offset = (canvas_size - safe) / 2
    ring_radius = safe * 0.35
    ring_width = max(scale, round(safe * 0.022))
    ring_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(ring_layer).ellipse(
        (center - ring_radius, center - ring_radius, center + ring_radius, center + ring_radius),
        outline=(255, 255, 255, 58),
        width=ring_width,
    )
    canvas.alpha_composite(ring_layer)
    draw = ImageDraw.Draw(canvas)

    points = [
        (0.19, 0.52),
        (0.35, 0.52),
        (0.41, 0.38),
        (0.50, 0.68),
        (0.59, 0.44),
        (0.67, 0.52),
        (0.81, 0.52),
    ]
    pulse = [(offset + x * safe, offset + y * safe) for x, y in points]
    pulse_width = max(scale * 2, round(safe * 0.052))
    draw.line(pulse, fill="white", width=pulse_width, joint="curve")
    radius_cap = pulse_width / 2
    for x, y in (pulse[0], pulse[-1]):
        draw.ellipse((x - radius_cap, y - radius_cap, x + radius_cap, y + radius_cap), fill="white")

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    icons = ROOT / "icons"
    icons.mkdir(exist_ok=True)

    render_icon(180, maskable=True).save(ROOT / "apple-touch-icon.png", optimize=True)
    render_icon(192).save(icons / "icon-192.png", optimize=True)
    render_icon(512).save(icons / "icon-512.png", optimize=True)
    render_icon(512, maskable=True).save(icons / "icon-maskable-512.png", optimize=True)

    render_icon(48).save(
        ROOT / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )


if __name__ == "__main__":
    main()
