"""
Predict visual saliency via Hugging Face Inference API and apply foveal blur.

Install:
    pip install requests pillow numpy opencv-python

Run:
    python scripts/attention_saliency.py

Edit INPUT_IMAGE_PATH, HF_TOKEN, and MODEL_URL below before running.
Output is saved as attention_blur_output.jpg
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import cv2
import numpy as np
import requests
from PIL import Image

# --- Insert your settings here ---
INPUT_IMAGE_PATH = "input.jpg"  # Path to your input image
HF_TOKEN = "hf_YOUR_TOKEN_HERE"  # Your Hugging Face API token
MODEL_URL = (
    "https://api-inference.huggingface.co/models/alexanderkroner/MSI-Net"
)

OUTPUT_PATH = "attention_blur_output.jpg"
PERIPHERAL_BLUR_RADIUS = 28  # Gaussian blur for peripheral vision
DESATURATION = 0.45  # 0 = full color, 1 = grayscale periphery


def fetch_saliency_map(image_path: str, token: str, model_url: str) -> np.ndarray:
    """Send image to Hugging Face API and return grayscale saliency (float32)."""
    if token == "hf_YOUR_TOKEN_HERE" or not token.strip():
        raise ValueError("Set HF_TOKEN to your Hugging Face API token.")

    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"Input image not found: {image_path}")

    headers = {"Authorization": f"Bearer {token}"}
    with path.open("rb") as image_file:
        response = requests.post(
            model_url,
            headers=headers,
            data=image_file.read(),
            timeout=120,
        )

    if response.status_code == 503:
        raise RuntimeError(
            "Model is loading on Hugging Face (503). Wait and retry."
        )
    if not response.ok:
        raise RuntimeError(
            f"Hugging Face API error ({response.status_code}): {response.text}"
        )

    # Load API image response with OpenCV as grayscale float32
    buffer = np.frombuffer(response.content, dtype=np.uint8)
    saliency_u8 = cv2.imdecode(buffer, cv2.IMREAD_GRAYSCALE)
    if saliency_u8 is None:
        # Fallback: PIL for formats OpenCV cannot decode directly
        saliency_u8 = np.array(
            Image.open(io.BytesIO(response.content)).convert("L"),
            dtype=np.uint8,
        )

    return saliency_u8.astype(np.float32)


def normalize_saliency(saliency: np.ndarray) -> np.ndarray:
    """Normalize saliency map strictly to 0.0 (no attention) .. 1.0 (max attention)."""
    min_val = float(saliency.min())
    max_val = float(saliency.max())
    if max_val > min_val:
        return (saliency - min_val) / (max_val - min_val)
    return np.zeros_like(saliency, dtype=np.float32)


def create_peripheral_image(
    rgb: np.ndarray,
    blur_radius: float,
    desaturation: float,
) -> np.ndarray:
    """Strong Gaussian blur + slight desaturation for peripheral vision."""
    blurred = cv2.GaussianBlur(
        rgb,
        ksize=(0, 0),
        sigmaX=blur_radius,
        sigmaY=blur_radius,
    )
    gray = (
        0.299 * blurred[:, :, 0]
        + 0.587 * blurred[:, :, 1]
        + 0.114 * blurred[:, :, 2]
    )
    out = blurred.astype(np.float32)
    for c in range(3):
        out[:, :, c] = blurred[:, :, c] * (1 - desaturation) + gray * desaturation
    return out


def blend_with_mask(
    sharp: np.ndarray,
    peripheral: np.ndarray,
    mask: np.ndarray,
) -> np.ndarray:
    """Result = Sharp * Mask + Blurred * (1 - Mask)."""
    inv = 1.0 - mask
    result = sharp * mask[:, :, None] + peripheral * inv[:, :, None]
    return np.clip(result, 0, 255).astype(np.uint8)


def resize_mask_to_image(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    if mask.shape[0] == height and mask.shape[1] == width:
        return mask
    resized = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
    return resized.astype(np.float32)


def run_attention_blur(
    input_path: str = INPUT_IMAGE_PATH,
    output_path: str = OUTPUT_PATH,
    token: str = HF_TOKEN,
    model_url: str = MODEL_URL,
    blur_radius: float = PERIPHERAL_BLUR_RADIUS,
    desaturation: float = DESATURATION,
) -> None:
    # 1. Load input image
    original_bgr = cv2.imread(input_path)
    if original_bgr is None:
        raise FileNotFoundError(f"Could not read image: {input_path}")

    height, width = original_bgr.shape[:2]
    sharp_rgb = cv2.cvtColor(original_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)

    # 2–3. Fetch saliency map from Hugging Face and normalize to [0, 1]
    saliency_raw = fetch_saliency_map(input_path, token, model_url)
    saliency_raw = resize_mask_to_image(saliency_raw, width, height)
    mask = normalize_saliency(saliency_raw)

    # 4. Peripheral vision version
    peripheral_rgb = create_peripheral_image(sharp_rgb, blur_radius, desaturation)

    # 5. Blend using saliency mask
    result_rgb = blend_with_mask(sharp_rgb, peripheral_rgb, mask)

    # 6. Save output
    result_bgr = cv2.cvtColor(result_rgb, cv2.COLOR_RGB2BGR)
    cv2.imwrite(output_path, result_bgr)
    print(f"Saved {output_path}")


if __name__ == "__main__":
    input_path = sys.argv[1] if len(sys.argv) > 1 else INPUT_IMAGE_PATH
    output_path = sys.argv[2] if len(sys.argv) > 2 else OUTPUT_PATH

    try:
        run_attention_blur(input_path=input_path, output_path=output_path)
    except (ValueError, FileNotFoundError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
