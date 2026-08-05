/**
 * Vercel serverless proxy for Hugging Face saliency inference.
 * Set HF_TOKEN and optionally HF_SALIENCY_MODEL_URL in Vercel environment variables.
 */

const DEFAULT_MODEL_URL =
  "https://api-inference.huggingface.co/models/YOUR_ORG/YOUR_SALIENCY_MODEL";

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

  try {
    const response = await fetch(modelUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType ?? "image/jpeg",
      },
      body: imageBuffer,
    });

    if (!response.ok) {
      const text = await response.text();
      res.status(response.status).json({
        error: `Hugging Face API error (${response.status}): ${text}`,
      });
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "image/png";

    res.status(200).json({
      imageBase64: Buffer.from(arrayBuffer).toString("base64"),
      mimeType: contentType,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown saliency API error";
    res.status(500).json({ error: message });
  }
}
