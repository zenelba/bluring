import { jsPDF } from "jspdf";
import { domToCanvas, waitUntilLoad } from "modern-screenshot";
import { downloadBlob } from "../report";
import {
  ORIGIN_LABELS,
  ORIGIN_ORDER,
  type Brand,
  type BrandArea,
  type BrandCategory,
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function brandLogoHtml(brand: Brand): string {
  const src = brand.logoSrc;
  if (!src) {
    const initials = brand.name.slice(0, 2).toUpperCase();
    return `<span class="fb-logo-fallback" aria-hidden="true">${initials}</span>`;
  }
  const svg = src.replace(/\.png$/i, ".svg");
  return `<img class="fb-logo-img" src="${src}" alt="" data-fallback="${svg !== src ? svg : ""}" />`;
}

function attachLogoErrorHandler(root: HTMLElement): void {
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
      const name = target
        .closest(".fb-logo-card")
        ?.querySelector(".fb-logo-name")?.textContent;
      const initials = (name ?? "?").slice(0, 2).toUpperCase();
      const span = document.createElement("span");
      span.className = "fb-logo-fallback";
      span.setAttribute("aria-hidden", "true");
      span.textContent = initials;
      target.replaceWith(span);
    },
    true,
  );
}

/** One page = one category with all origin subgroups on the same page. */
function buildCategoryPage(category: BrandCategory): HTMLElement {
  const root = document.createElement("div");
  root.className = "fb-pdf-export fb-pdf-export--page";
  root.setAttribute("aria-hidden", "true");

  const section = document.createElement("section");
  section.className = "fb-exploded-cat";

  const head = document.createElement("div");
  head.className = "fb-exploded-cat__head";
  head.innerHTML = `
    <span class="fb-cat-row__num">${String(category.number).padStart(2, "0")}</span>
    <div>
      <h3 class="fb-exploded-cat__title">${escapeHtml(category.title)}</h3>
      <p class="fb-exploded-cat__meta">${category.brands.length} znamk</p>
    </div>
  `;
  section.appendChild(head);

  for (const origin of ORIGIN_ORDER) {
    const brands = category.brands.filter((b) => b.origin === origin);
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

  root.appendChild(section);
  attachLogoErrorHandler(root);
  return root;
}

async function prepareRoot(root: HTMLElement): Promise<void> {
  await waitUntilLoad(root, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 120));
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
}

function fitCanvasToPage(
  pdf: jsPDF,
  canvas: HTMLCanvasElement,
  margin: number,
): void {
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - margin * 2;
  const contentH = pageH - margin * 2;
  const scale = Math.min(contentW / canvas.width, contentH / canvas.height);
  const wMm = canvas.width * scale;
  const hMm = canvas.height * scale;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  pdf.addImage(dataUrl, "JPEG", margin, margin, wMm, hMm);
}

/** Export logos-only PDF: one category per page (origins stay together). */
export async function exportAreaPdf(area: BrandArea): Promise<void> {
  const categories = area.categories;
  if (categories.length === 0) return;

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const margin = 10;

  for (let i = 0; i < categories.length; i++) {
    const root = buildCategoryPage(categories[i]!);
    document.body.appendChild(root);
    try {
      await prepareRoot(root);
      const canvas = await domToCanvas(root, {
        scale: 2,
        backgroundColor: "#eef0f3",
      });
      if (i > 0) pdf.addPage();
      fitCanvasToPage(pdf, canvas, margin);
    } finally {
      root.remove();
    }
  }

  const fileName = `find-brands-${slugify(area.title) || "area"}.pdf`;
  downloadBlob(pdf.output("blob"), fileName);
}
