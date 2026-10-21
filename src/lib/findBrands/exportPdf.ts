import { jsPDF } from "jspdf";
import { domToCanvas, waitUntilLoad } from "modern-screenshot";
import { downloadBlob } from "../report";
import {
  ORIGIN_LABELS,
  ORIGIN_ORDER,
  type Brand,
  type BrandArea,
} from "./types";

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function brandLogoHtml(brand: Brand): string {
  const src = brand.logoSrc;
  if (!src) {
    const initials = brand.name.slice(0, 2).toUpperCase();
    return `<span class="fb-logo-fallback" aria-hidden="true">${initials}</span>`;
  }
  const svg = src.replace(/\.png$/i, ".svg");
  // Prefer PNG when present; onError swaps to SVG (same as LogoImg in UI).
  return `<img class="fb-logo-img" src="${src}" alt="" data-fallback="${svg !== src ? svg : ""}" />`;
}

/** Off-screen tree matching Explode-all: categories → origin → logo cards only. */
function buildExportRoot(area: BrandArea): HTMLElement {
  const root = document.createElement("div");
  root.className = "fb-pdf-export";
  root.setAttribute("aria-hidden", "true");

  const stack = document.createElement("div");
  stack.className = "fb-exploded";

  for (const cat of area.categories) {
    const section = document.createElement("section");
    section.className = "fb-exploded-cat";

    const head = document.createElement("div");
    head.className = "fb-exploded-cat__head";
    head.innerHTML = `
      <span class="fb-cat-row__num">${String(cat.number).padStart(2, "0")}</span>
      <div>
        <h3 class="fb-exploded-cat__title">${escapeHtml(cat.title)}</h3>
        <p class="fb-exploded-cat__meta">${cat.brands.length} znamk</p>
      </div>
    `;
    section.appendChild(head);

    for (const origin of ORIGIN_ORDER) {
      const brands = cat.brands.filter((b) => b.origin === origin);
      if (brands.length === 0) continue;

      const originEl = document.createElement("section");
      originEl.className = "fb-origin-section";
      originEl.innerHTML = `<h3 class="fb-origin-title">${ORIGIN_LABELS[origin]}</h3>`;

      const grid = document.createElement("div");
      grid.className = "fb-logo-grid";
      for (const brand of brands) {
        const card = document.createElement("div");
        card.className = "fb-logo-card fb-logo-card--static";
        card.innerHTML = `
          <span class="fb-logo-frame">${brandLogoHtml(brand)}</span>
          <span class="fb-logo-name">${escapeHtml(brand.name)}</span>
        `;
        grid.appendChild(card);
      }
      originEl.appendChild(grid);
      section.appendChild(originEl);
    }

    stack.appendChild(section);
  }

  root.appendChild(stack);

  root.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      const fallback = target.dataset.fallback;
      if (fallback && target.src !== fallback) {
        target.dataset.fallback = "";
        target.src = fallback;
        return;
      }
      const name = target.closest(".fb-logo-card")?.querySelector(".fb-logo-name")
        ?.textContent;
      const initials = (name ?? "?").slice(0, 2).toUpperCase();
      const span = document.createElement("span");
      span.className = "fb-logo-fallback";
      span.setAttribute("aria-hidden", "true");
      span.textContent = initials;
      target.replaceWith(span);
    },
    true,
  );

  return root;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function canvasToPdfPages(canvas: HTMLCanvasElement): Promise<Blob> {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const contentW = pageW - margin * 2;
  const contentH = pageH - margin * 2;

  const pageHeightPx = (contentH / contentW) * canvas.width;
  let srcY = 0;
  let pageIndex = 0;

  while (srcY < canvas.height - 1) {
    const sliceH = Math.min(pageHeightPx, canvas.height - srcY);
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    pageCanvas.height = Math.ceil(sliceH);
    const ctx = pageCanvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.fillStyle = "#eef0f3";
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    ctx.drawImage(
      canvas,
      0,
      srcY,
      canvas.width,
      sliceH,
      0,
      0,
      canvas.width,
      sliceH,
    );

    const dataUrl = pageCanvas.toDataURL("image/jpeg", 0.92);
    if (pageIndex > 0) pdf.addPage();
    const hMm = (sliceH / canvas.width) * contentW;
    pdf.addImage(dataUrl, "JPEG", margin, margin, contentW, hMm);

    srcY += sliceH;
    pageIndex += 1;
  }

  return pdf.output("blob");
}

/** Export Explode-all structure only: category → origin → logo cards. */
export async function exportAreaPdf(area: BrandArea): Promise<void> {
  const root = buildExportRoot(area);
  document.body.appendChild(root);

  try {
    await waitUntilLoad(root, { timeout: 20000 });
    // Allow PNG→SVG onError swaps to settle, then decode.
    await new Promise((r) => setTimeout(r, 250));
    const imgs = [...root.querySelectorAll("img")];
    await Promise.all(
      imgs.map((img) =>
        img.decode().catch(() => undefined),
      ),
    );

    const canvas = await domToCanvas(root, {
      scale: 2,
      backgroundColor: "#eef0f3",
    });

    const blob = await canvasToPdfPages(canvas);
    const fileName = `find-brands-${slugify(area.title) || "area"}.pdf`;
    downloadBlob(blob, fileName);
  } finally {
    root.remove();
  }
}
