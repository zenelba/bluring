/**
 * Vercel serverless proxy for MSI-Net saliency via Hugging Face Space:
 * https://huggingface.co/spaces/alexanderkroner/saliency
 *
 * Flow: upload image → Gradio /predict → download saliency map.
 * Optional: set HF_TOKEN if the Space is private / rate-limited.
 */

const SPACE_HOST =
  process.env.HF_SALIENCY_SPACE_URL ??
  "https://alexanderkroner-saliency.hf.space";

interface SaliencyRequestBody {
  imageBase64?: string;
  mimeType?: string;
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "jpg";
}

async function uploadToSpace(
  imageBuffer: Buffer,
  mimeType: string,
  authHeader?: string,
): Promise<string> {
  const filename = `upload.${extensionForMime(mimeType)}`;
  const form = new FormData();
  form.append(
    "files",
    new Blob([new Uint8Array(imageBuffer)], { type: mimeType }),
    filename,
  );

  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;

  const response = await fetch(`${SPACE_HOST}/gradio_api/upload`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Space upload failed (${response.status}): ${text}`);
  }

  const uploaded = (await response.json()) as string[] | string;
  const path = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (!path) throw new Error("Space upload returned no file path");
  return path;
}

async function callPredict(
  uploadedPath: string,
  mimeType: string,
  filename: string,
  size: number,
  authHeader?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;

  const response = await fetch(`${SPACE_HOST}/gradio_api/call/predict`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: [
        {
          path: uploadedPath,
          url: null,
          orig_name: filename,
          mime_type: mimeType,
          size,
          is_stream: false,
          meta: { _type: "gradio.FileData" },
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Space predict call failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as { event_id?: string };
  if (!body.event_id) throw new Error("Space predict returned no event_id");
  return body.event_id;
}

async function waitForSaliencyUrl(
  eventId: string,
  authHeader?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };
  if (authHeader) headers.Authorization = authHeader;

  const response = await fetch(
    `${SPACE_HOST}/gradio_api/call/predict/${eventId}`,
    { headers },
  );

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Space SSE failed (${response.status}): ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;

      const data = line.slice(5).trim();
      if (currentEvent === "error") {
        throw new Error(`Space predict error: ${data}`);
      }
      if (currentEvent !== "complete") continue;

      const parsed = JSON.parse(data) as Array<{ url?: string | null }>;
      const url = parsed?.[0]?.url;
      if (!url) throw new Error("Space predict completed without image URL");
      return url;
    }
  }

  throw new Error("Space SSE ended before complete event");
}

async function downloadImage(
  url: string,
  authHeader?: string,
): Promise<{ arrayBuffer: ArrayBuffer; contentType: string }> {
  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to download saliency map (${response.status}): ${text}`);
  }

  return {
    arrayBuffer: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "image/webp",
  };
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

  const { imageBase64, mimeType: rawMime } = req.body ?? {};
  if (!imageBase64) {
    res.status(400).json({ error: "Missing imageBase64 in request body" });
    return;
  }

  const mimeType = rawMime ?? "image/jpeg";
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const token = process.env.HF_TOKEN?.trim();
  const authHeader = token ? `Bearer ${token}` : undefined;
  const filename = `upload.${extensionForMime(mimeType)}`;

  try {
    const uploadedPath = await uploadToSpace(imageBuffer, mimeType, authHeader);
    const eventId = await callPredict(
      uploadedPath,
      mimeType,
      filename,
      imageBuffer.byteLength,
      authHeader,
    );
    const saliencyUrl = await waitForSaliencyUrl(eventId, authHeader);
    const { arrayBuffer, contentType } = await downloadImage(
      saliencyUrl,
      authHeader,
    );

    res.status(200).json({
      imageBase64: Buffer.from(arrayBuffer).toString("base64"),
      mimeType: contentType,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown saliency Space error";
    res.status(500).json({ error: message });
  }
}
