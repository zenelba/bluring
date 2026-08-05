"""
Predict visual saliency via the MSI-Net Hugging Face Space and apply foveal blur.

Space: https://huggingface.co/spaces/alexanderkroner/saliency
Host:  https://alexanderkroner-saliency.hf.space

Install:
    pip install requests pillow numpy opencv-python gradio_client

Run:
    python scripts/attention_saliency.py input.jpg attention_blur_output.jpg

Edit INPUT_IMAGE_PATH below (and optionally HF_TOKEN for private/rate-limited use).
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import requests
from PIL import Image

# --- Insert your settings here ---
INPUT_IMAGE_PATH = "input.jpg"  # Path to your input image
# Optional: only needed for private Spaces / higher rate limits
HF_TOKEN = ""  # e.g. "hf_..."
SPACE_HOST = "https://alexanderkroner-saliency.hf.space"

OUTPUT_PATH = "attention_blur_output.jpg"
PERIPHERAL_BLUR_RADIUS = 28  # Gaussian blur for peripheral vision
DESATURATION = 0.45  # 0 = full color, 1 = grayscale periphery


def fetch_saliency_overlay(
    image_path: str, token: str = "", space_host: str = SPACE_HOST
) -> np.ndarray:
    """
    Send image to the MSI-Net Gradio Space and return the RGB overlay (uint8).

    The Space returns: alpha * inferno(s) + (1 - alpha) * image/255
    Prefer gradio_client when available; fall back to raw Gradio HTTP API.
    """
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"Input image not found: {image_path}")

    try:
        from gradio_client import Client, handle_file

        client = Client(space_host, hf_token=token or None)
        result_path = client.predict(handle_file(str(path)), api_name="/predict")
        return np.array(Image.open(result_path).convert("RGB"), dtype=np.uint8)
    except Exception:
        headers = {"Authorization": f"Bearer {token}"} if token.strip() else {}

        with path.open("rb") as image_file:
            upload = requests.post(
                f"{space_host}/gradio_api/upload",
                headers=headers,
                files={"files": (path.name, image_file, "application/octet-stream")},
                timeout=120,
            )
        if not upload.ok:
            raise RuntimeError(f"Space upload failed ({upload.status_code}): {upload.text}")

        uploaded = upload.json()
        uploaded_path = uploaded[0] if isinstance(uploaded, list) else uploaded

        call = requests.post(
            f"{space_host}/gradio_api/call/predict",
            headers={**headers, "Content-Type": "application/json"},
            json={
                "data": [
                    {
                        "path": uploaded_path,
                        "url": None,
                        "orig_name": path.name,
                        "mime_type": "image/jpeg",
                        "size": path.stat().st_size,
                        "is_stream": False,
                        "meta": {"_type": "gradio.FileData"},
                    }
                ]
            },
            timeout=120,
        )
        if not call.ok:
            raise RuntimeError(f"Space predict call failed ({call.status_code}): {call.text}")

        event_id = call.json().get("event_id")
        if not event_id:
            raise RuntimeError("Space predict returned no event_id")

        stream = requests.get(
            f"{space_host}/gradio_api/call/predict/{event_id}",
            headers={**headers, "Accept": "text/event-stream"},
            stream=True,
            timeout=180,
        )
        if not stream.ok:
            raise RuntimeError(f"Space SSE failed ({stream.status_code}): {stream.text}")

        event_name = ""
        saliency_url = None
        for raw in stream.iter_lines(decode_unicode=True):
            if not raw:
                continue
            if raw.startswith("event:"):
                event_name = raw[6:].strip()
                continue
            if not raw.startswith("data:"):
                continue
            data = raw[5:].strip()
            if event_name == "error":
                raise RuntimeError(f"Space predict error: {data}")
            if event_name == "complete":
                payload = json.loads(data)
                saliency_url = payload[0].get("url")
                break

        if not saliency_url:
            raise RuntimeError("Space SSE ended without a saliency image URL")

        image_res = requests.get(saliency_url, headers=headers, timeout=120)
        if not image_res.ok:
            raise RuntimeError(
                f"Failed to download saliency map ({image_res.status_code}): {image_res.text}"
            )

        return np.array(
            Image.open(io.BytesIO(image_res.content)).convert("RGB"),
            dtype=np.uint8,
        )


def normalize_saliency(saliency: np.ndarray) -> np.ndarray:
    """Normalize saliency map strictly to 0.0 (no attention) .. 1.0 (max attention)."""
    min_val = float(saliency.min())
    max_val = float(saliency.max())
    if max_val > min_val:
        return (saliency - min_val) / (max_val - min_val)
    return np.zeros_like(saliency, dtype=np.float32)


def space_overlay_to_mask(
    space_rgb: np.ndarray,
    original_rgb: np.ndarray,
    overlay_alpha: float = 0.65,
) -> np.ndarray:
    """
    Invert the Space visualization:
      out = alpha * inferno(s) + (1 - alpha) * image/255
    back into a grayscale saliency mask in [0, 1].
    """
    import matplotlib.pyplot as plt

    space = space_rgb.astype(np.float32)
    original = original_rgb.astype(np.float32)
    inferno_rgb = (space - (1.0 - overlay_alpha) * original) / overlay_alpha
    inferno_rgb = np.clip(inferno_rgb, 0, 255)

    lut = (plt.cm.inferno(np.linspace(0, 1, 256))[:, :3] * 255).astype(np.float32)
    flat = inferno_rgb.reshape(-1, 3)
    # Nearest LUT index per pixel
    # Use chunked distance for memory
    indices = np.empty(flat.shape[0], dtype=np.int32)
    chunk = 50000
    for start in range(0, flat.shape[0], chunk):
        end = min(start + chunk, flat.shape[0])
        diffs = flat[start:end, None, :] - lut[None, :, :]
        dist = np.sum(diffs * diffs, axis=2)
        indices[start:end] = np.argmin(dist, axis=1)

    mask = indices.astype(np.float32).reshape(space_rgb.shape[:2]) / 255.0
    return normalize_saliency(mask)


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


def resize_to_image(arr: np.ndarray, width: int, height: int) -> np.ndarray:
    if arr.shape[0] == height and arr.shape[1] == width:
        return arr
    return cv2.resize(arr, (width, height), interpolation=cv2.INTER_LINEAR)


def run_attention_blur(
    input_path: str = INPUT_IMAGE_PATH,
    output_path: str = OUTPUT_PATH,
    token: str = HF_TOKEN,
    blur_radius: float = PERIPHERAL_BLUR_RADIUS,
    desaturation: float = DESATURATION,
) -> None:
    # 1. Load input image
    original_bgr = cv2.imread(input_path)
    if original_bgr is None:
        raise FileNotFoundError(f"Could not read image: {input_path}")

    height, width = original_bgr.shape[:2]
    sharp_rgb = cv2.cvtColor(original_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)

    # 2–3. Fetch Space overlay and recover saliency mask
    overlay_rgb = fetch_saliency_overlay(input_path, token=token)
    overlay_rgb = resize_to_image(overlay_rgb, width, height)
    mask = space_overlay_to_mask(overlay_rgb, sharp_rgb)

    # Also save Space-style map next to the blur output
    map_path = str(Path(output_path).with_name(Path(output_path).stem + "_map.jpg"))
    cv2.imwrite(map_path, cv2.cvtColor(overlay_rgb, cv2.COLOR_RGB2BGR))
    print(f"Saved {map_path}")

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
