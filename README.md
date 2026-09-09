# Visuals insight

Web app for image processing, collage layout, portrait pipelines, and audio/video download + analysis. Pick a mode from the header dropdown, upload or paste a link, and export results.

**Live:** [bluring-xi.vercel.app](https://bluring-xi.vercel.app)

Access is gated behind an access code (session cookie). Server-side features (Attention saliency, Audio/Video download & transcription) require a valid session and the env vars below.

---

## Modes

| Mode | What it does |
|------|----------------|
| **Logo blur** | Draw rectangles over logos; stepped blur intensity; export PNG/JPEG |
| **Foveal vision** | Sharp centre, soft periphery — simulate central vision |
| **Attention** | MSI-Net saliency map; blur everything except predicted gaze hotspots |
| **PowerPoint** | Build a `.pptx` deck from blur, attention, and foveal analyses |
| **Faces** | Batch portrait pipeline: face crop, optional BG removal, ZIP export |
| **Collages** | Sort images by filename, strip whitespace, optional BG fill, ribbons or packed grids |
| **Audio / Video** | Download YouTube/Facebook media, pick quality, transcribe, extract slides |

### Collages

- Upload images or ZIP; natural sort (`2` before `12`)
- Layouts: vertical ribbon, horizontal ribbon, or **collage grid**
- Exact grid tilings for *N* images (e.g. 12 → `12×1` … `1×12`); **ALL** builds every tiling and downloads a ZIP
- Per-row/column cell sizing (tight pack), optional gap, strip whitespace, BG removal
- PowerPoint-friendly export (1920px edge, JPEG) on by default
- Download filenames include layout, grid, pixels, and strip mode

### Faces (Portraits)

- Filename ID prefix (e.g. `01_Name.jpg`); batch ZIP with optional `brands.json`
- Smart face crop, configurable output size, background removal model picker
- Runs entirely in the browser (TensorFlow face detection + `@imgly/background-removal`)

### Audio / Video

- Paste a **YouTube** or **Facebook** URL → choose quality (1080p, 720p, audio-only, …)
- Multi-item links show a picker when Cobalt returns several assets
- **Transcription** (OpenAI Whisper, on by default)
- **Slide detection** on video: export changed frames as images + PDF (both on by default)
- Or upload a local video/audio file for analysis only

Requires a **self-hosted [Cobalt](https://github.com/imputnet/cobalt)** instance (`COBALT_API_URL`). Public `cobalt.tools` is not intended for third-party apps. For production on Vercel, Cobalt must be reachable over **public HTTPS** (Synology reverse proxy, Cloudflare Tunnel, etc.).

---

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

- **UI only:** `npm run dev` is enough for Logo blur, Foveal, Faces, and Collages.
- **API routes** (`/api/access`, `/api/saliency`, `/api/av-*`): use [Vercel CLI](https://vercel.com/docs/cli) locally:

```bash
cp .env.example .env.local
# edit .env.local
npx vercel dev
```

Copy `.env.example` → `.env.local` and fill in values as needed.

---

## Environment variables

| Variable | Required for | Description |
|----------|----------------|-------------|
| `ACCESS_SECRET` | Production | HMAC secret for access-session cookies |
| `HF_TOKEN` | Optional | Hugging Face token (saliency rate limits / auth) |
| `HF_SALIENCY_SPACE_URL` | Optional | Gradio Space URL (default: alexanderkroner/saliency) |
| `COBALT_API_URL` | Audio/Video downloads | Base URL of your Cobalt instance (no trailing path required) |
| `COBALT_API_KEY` | Optional | `Api-Key` if Cobalt auth is enabled |
| `OPENAI_API_KEY` | Transcription | Whisper API |
| `OPENAI_BASE_URL` | Optional | OpenAI-compatible API base |

See [`.env.example`](.env.example) for a template.

---

## Build & preview

```bash
npm run build
npm run preview
```

Static output goes to `dist/`. Vercel runs `npm run build` and serves `dist` plus serverless functions under `api/`.

---

## Deploy

Pushes to `main` deploy automatically to [Vercel](https://bluring-xi.vercel.app).

1. Connect the GitHub repo in Vercel.
2. Set environment variables in the Vercel project (at minimum `ACCESS_SECRET`; plus Cobalt/OpenAI for Audio/Video).
3. Ensure Cobalt is on a **public HTTPS URL** if Audio/Video runs in production (Vercel cannot reach a LAN-only NAS IP).

### Self-hosting Cobalt (Synology / Docker)

Minimal Docker Compose:

```yaml
services:
  cobalt:
    image: ghcr.io/imputnet/cobalt:11
    restart: unless-stopped
    ports:
      - "9000:9000"
    environment:
      API_URL: "https://cobalt.yourdomain.example/"
```

Point `COBALT_API_URL` at that URL. Docs: [run an instance](https://github.com/imputnet/cobalt/blob/current/docs/run-an-instance.md), [protect an instance](https://github.com/imputnet/cobalt/blob/current/docs/protect-an-instance.md).

---

## API routes (Vercel serverless)

| Route | Purpose |
|-------|---------|
| `GET/POST /api/access` | Session check / unlock with access code |
| `POST /api/saliency` | Proxy to HF Gradio saliency Space |
| `POST /api/av-probe` | Resolve media URL and quality options (Cobalt) |
| `POST /api/av-download` | Start download for chosen quality |
| `GET /api/av-fetch` | Proxy media bytes to the browser |
| `POST /api/av-transcribe` | Whisper transcription |

All except `/api/access` require a valid access cookie.

---

## Stack

- **Frontend:** React 19, Vite, TypeScript
- **Image ML (browser):** TensorFlow.js face detection, `@imgly/background-removal`, ONNX Runtime Web
- **Export:** `pptxgenjs`, `jszip`, `file-saver`, `jspdf`
- **Backend:** Vercel serverless (Node), Hugging Face Gradio, Cobalt, OpenAI Whisper

---

## License

Private repository — see owner for usage terms.
