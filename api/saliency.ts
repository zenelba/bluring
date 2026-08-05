/**
 * Vercel serverless proxy for Hugging Face saliency inference.
 * Set HF_TOKEN and optionally HF_SALIENCY_MODEL_URL in Vercel environment variables.
 */

const DEFAULT_MODEL_URL =
  "https://api-inference.huggingface.co/models/alexanderkroner/MSI-Net";

function buildRouterFallbackUrl(modelUrl: string): string | null {
  const prefix = "https://api-inference.huggingface.co/models/";
  if (!modelUrl.startsWith(prefix)) return null;
  const modelId = modelUrl.slice(prefix.length);
  if (!modelId) return null;
  return `https://router.huggingface.co/hf-inference/models/${modelId}`;
}

interface SaliencyRequestBody {
  imageBase64?: string;
  mimeType?: string;
}

export default async function handler(
  req: { method?: string; body?: SaliencyRequestBody },
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    setHeader: (name: string, value: string) => void;
  },
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.HF_TOKEN;
  if (!token) {
    res.status(500).json({
      error:
        "HF_TOKEN is not configured. Add your Hugging Face token in Vercel project settings.",
    });
    return;
  }

  const { imageBase64, mimeType } = req.body ?? {};
  if (!imageBase64) {
    res.status(400).json({ error: "Missing imageBase64 in request body" });
    return;
  }

  const modelUrl = process.env.HF_SALIENCY_MODEL_URL ?? DEFAULT_MODEL_URL;
  const imageBuffer = Buffer.from(imageBase64, "base64");

  async function callHf(url: string) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType ?? "image/jpeg",
        Accept: "image/*",
      },
      body: imageBuffer,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Hugging Face API error (${response.status}): ${text}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "image/png";
    return { arrayBuffer, contentType };
  }

  try {
    const { arrayBuffer, contentType } = await callHf(modelUrl);
    res.status(200).json({
      imageBase64: Buffer.from(arrayBuffer).toString("base64"),
      mimeType: contentType,
    });
  } catch (error) {
    const primaryMessage =
      error instanceof Error ? error.message : "Unknown saliency API error";

    const routerUrl = buildRouterFallbackUrl(modelUrl);
    if (!routerUrl) {
      res.status(500).json({ error: primaryMessage });
      return;
    }

    try {
      const { arrayBuffer, contentType } = await callHf(routerUrl);
      res.status(200).json({
        imageBase64: Buffer.from(arrayBuffer).toString("base64"),
        mimeType: contentType,
      });
    } catch (error2) {
      const secondaryMessage =
        error2 instanceof Error
          ? error2.message
          : "Unknown router saliency API error";
      res.status(500).json({
        error: `${primaryMessage}\nFallback failed: ${secondaryMessage}`,
      });
    }
  }
}
