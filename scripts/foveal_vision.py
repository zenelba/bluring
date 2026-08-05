"""
Foveal vision simulation — peripheral blur + radial mask blend.

Adjust the variables below, then run:
    pip install pillow numpy
    python scripts/foveal_vision.py input.jpg output.png
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# --- Adjustable parameters ---
FOCAL_X = None  # None = image center
FOCAL_Y = None  # None = image center
FOVEA_RADIUS = 80  # pixels — sharp central region
TRANSITION_SPREAD = 240  # pixels — gradient width from fovea to periphery
BLUR_INTENSITY = 28  # Gaussian blur radius for peripheral vision
DESATURATION = 0.45  # 0 = full color, 1 = grayscale periphery


def smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def foveal_mask(
    width: int,
    height: int,
    focal_x: float,
    focal_y: float,
    fovea_radius: float,
    transition_spread: float,
) -> np.ndarray:
    ys = np.arange(height, dtype=np.float32)
    xs = np.arange(width, dtype=np.float32)
    dx = xs - focal_x
    dy = ys - focal_y
    dist = np.sqrt(dx[:, None] ** 2 + dy[None, :] ** 2)

    mask = np.zeros((height, width), dtype=np.float32)
    mask[dist <= fovea_radius] = 1.0

    if transition_spread > 0:
        transition = dist > fovea_radius
        t = (dist - fovea_radius) / transition_spread
        mask[transition] = 1.0 - smoothstep(t[transition])

    mask[dist >= fovea_radius + transition_spread] = 0.0
    return mask


def desaturate(rgb: np.ndarray, amount: float) -> np.ndarray:
    gray = (
        0.299 * rgb[:, :, 0]
        + 0.587 * rgb[:, :, 1]
        + 0.114 * rgb[:, :, 2]
    )
    out = rgb.copy()
    for c in range(3):
        out[:, :, c] = rgb[:, :, c] * (1 - amount) + gray * amount
    return out


def simulate_foveal_vision(
    image_path: str,
    output_path: str,
    focal_x: float | None = None,
    focal_y: float | None = None,
    fovea_radius: float = FOVEA_RADIUS,
    transition_spread: float = TRANSITION_SPREAD,
    blur_intensity: float = BLUR_INTENSITY,
    desaturation: float = DESATURATION,
) -> None:
    img = Image.open(image_path).convert("RGB")
    width, height = img.size

    fx = focal_x if focal_x is not None else width / 2
    fy = focal_y if focal_y is not None else height / 2

    sharp = np.array(img, dtype=np.float32)

    peripheral = img.filter(ImageFilter.GaussianBlur(radius=blur_intensity))
    peripheral = np.array(peripheral, dtype=np.float32)
    peripheral = desaturate(peripheral, desaturation)

    mask = foveal_mask(width, height, fx, fy, fovea_radius, transition_spread)
    inv = 1.0 - mask

    result = sharp * mask[:, :, None] + peripheral * inv[:, :, None]
    result = np.clip(result, 0, 255).astype(np.uint8)

    Image.fromarray(result).save(output_path)
    print(f"Saved {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python scripts/foveal_vision.py <input> <output>")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    simulate_foveal_vision(
        str(input_path),
        str(output_path),
        focal_x=FOCAL_X,
        focal_y=FOCAL_Y,
        fovea_radius=FOVEA_RADIUS,
        transition_spread=TRANSITION_SPREAD,
        blur_intensity=BLUR_INTENSITY,
        desaturation=DESATURATION,
    )
