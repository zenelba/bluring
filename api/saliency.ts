/**
 * Vercel serverless proxy for Hugging Face saliency inference.
 * Set HF_TOKEN and optionally HF_SALIENCY_MODEL_URL in Vercel environment variables.
 */

const DEFAULT_MODEL_URL =
  "https://api-inference.huggingface.co/models/alexanderkroner/MSI-Net";

function extractModelId(modelUrl: string): string | null {
  const idx = modelUrl.indexOf("/models/");
  if (idx === -1) return null;
  const modelId = modelUrl.slice(idx + "/models/".length);
  if (!modelId) return null;
  return modelId;
}

function buildCandidateModelUrls(primaryUrl: string): string[] {
  const candidates: string[] = [primaryUrl];
  const modelId = extractModelId(primaryUrl);
  if (!modelId) return candidates;

  // Try multiple Inference Providers (via HF Router).
  // This is intentionally a small list to avoid long retry chains.
  const providers = [
    "hf-inference",
    "fal-ai",
    "together",
    "replicate",
    "deepinfra",
    "fireworks-ai",
    "novita",
    "nscale",
    "scaleway",
    "wavespeed",
    "zai-org",
  ];

  for (const provider of providers) {
    candidates.push(
      `https://router.huggingface.co/${provider}/models/${modelId}`,
    );
  }

  // De-dupe while preserving order.
  return [...new Set(candidates)];
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

  const candidates = buildCandidateModelUrls(modelUrl);
  let lastError: string | null = null;

  for (const url of candidates) {
    try {
      const { arrayBuffer, contentType } = await callHf(url);
      res.status(200).json({
        imageBase64: Buffer.from(arrayBuffer).toString("base64"),
        mimeType: contentType,
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  res.status(500).json({
    error: `Saliency API failed for all providers.\nLast error: ${lastError}`,
  });
}
