import { jsPDF } from "jspdf";
import { downloadBlob } from "../report";
import { ORIGIN_LABELS, ORIGIN_ORDER, type BrandArea } from "./types";

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function wrapText(
  pdf: jsPDF,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const lines = pdf.splitTextToSize(text, maxWidth) as string[];
  for (const line of lines) {
    pdf.text(line, x, y);
    y += lineHeight;
  }
  return y;
}

function ensureSpace(pdf: jsPDF, y: number, needed: number, margin: number): number {
  const pageH = pdf.internal.pageSize.getHeight();
  if (y + needed > pageH - margin) {
    pdf.addPage();
    return margin;
  }
  return y;
}

/** Export full area catalog (all categories + brand matrices) to a PDF. */
export async function exportAreaPdf(area: BrandArea): Promise<void> {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const margin = 14;
  const contentW = pageW - margin * 2;
  let y = margin;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  y = wrapText(pdf, area.title, margin, y + 4, contentW, 7);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(80);
  y = wrapText(pdf, area.blurb, margin, y + 2, contentW, 5);
  pdf.setTextColor(0);
  y += 4;

  const totalBrands = area.categories.reduce((n, c) => n + c.brands.length, 0);
  pdf.setFontSize(9);
  pdf.setTextColor(100);
  pdf.text(
    `${area.categories.length} kategorij · ${totalBrands} znamk · Find Brands`,
    margin,
    y,
  );
  y += 8;
  pdf.setTextColor(0);

  for (const cat of area.categories) {
    y = ensureSpace(pdf, y, 18, margin);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(12);
    y = wrapText(
      pdf,
      `${String(cat.number).padStart(2, "0")} — ${cat.title}`,
      margin,
      y,
      contentW,
      6,
    );
    pdf.setDrawColor(200);
    pdf.line(margin, y, pageW - margin, y);
    y += 5;

    for (const origin of ORIGIN_ORDER) {
      const brands = cat.brands.filter((b) => b.origin === origin);
      if (brands.length === 0) continue;

      y = ensureSpace(pdf, y, 12, margin);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(10);
      pdf.setTextColor(70);
      pdf.text(ORIGIN_LABELS[origin], margin, y);
      y += 5;
      pdf.setTextColor(0);

      for (const brand of brands) {
        const block =
          6 +
          5 * 5 + // summary lines approx
          4;
        y = ensureSpace(pdf, y, block, margin);

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(10);
        y = wrapText(pdf, brand.name, margin, y, contentW, 5);

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(60);
        const lines: Array<[string, string]> = [
          ["Izvor", ORIGIN_LABELS[brand.origin]],
          ["Cenovni razred", brand.priceTier],
          ["USP", brand.usp],
          ["Prisotnost SLO", brand.presenceSi],
          ["Podjetje", brand.companyUrl],
          ["SLO / zastopnik", brand.sloveniaUrl ?? "Ni znan / ni relevantno"],
          ["Uradno ime", brand.profile.identity.legalName],
          ["Sedež", brand.profile.identity.hq],
          ["Ustanovitev", brand.profile.identity.founded],
          ["Lastništvo", brand.profile.identity.ownership],
          ["Prihodki", brand.profile.finance.revenue],
          ["Zaposleni", brand.profile.finance.employees],
          ["Izvoz", brand.profile.finance.exportShare],
          ["Linije", brand.profile.product.lines],
          ["Certifikati", brand.profile.product.techCerts],
          ["Proizvodnja", brand.profile.product.productionModel],
          ["Ciljna skupina", brand.profile.positioning.target],
          ["Model vstopa", brand.profile.distributionSi.entryModel],
          ["Partnerji", brand.profile.distributionSi.partners],
        ];

        for (const [label, value] of lines) {
          y = ensureSpace(pdf, y, 8, margin);
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(7.5);
          pdf.text(`${label}:`, margin, y);
          pdf.setFont("helvetica", "normal");
          y = wrapText(pdf, value, margin + 28, y, contentW - 28, 3.8);
          y += 1.2;
        }

        pdf.setTextColor(0);
        y += 4;
      }
    }

    y += 3;
  }

  const fileName = `find-brands-${slugify(area.title) || "area"}.pdf`;
  downloadBlob(pdf.output("blob"), fileName);
}
