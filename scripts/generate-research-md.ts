import { writeFileSync, mkdirSync } from "fs";
import { WOOD_CATEGORIES } from "../src/lib/findBrands/wood/brands.ts";
import {
  ORIGIN_LABELS,
  type Brand,
  type BrandOrigin,
} from "../src/lib/findBrands/types.ts";

mkdirSync("raziskava_lesna_industrija", { recursive: true });
const origins: BrandOrigin[] = ["si", "foreign_in_si", "eu_strong"];

function mdEscape(s: string) {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function brandSection(b: Brand): string {
  const p = b.profile;
  return [
    `## ${b.name}`,
    "",
    `- **Izvor:** ${ORIGIN_LABELS[b.origin]}`,
    `- **Logotip:** \`${b.logoSrc}\``,
    `- **URL podjetja:** ${b.companyUrl}`,
    `- **URL SLO / zastopnik:** ${b.sloveniaUrl ?? "Ni znan / ni relevantno"}`,
    "",
    "### 1. Osnovna osebna izkaznica",
    `- **Uradno ime:** ${p.identity.legalName}`,
    `- **Sedež:** ${p.identity.hq}`,
    `- **Ustanovitev:** ${p.identity.founded}`,
    `- **Lastništvo:** ${p.identity.ownership}`,
    "",
    "### 2. Poslovno-finančni profil",
    `- **Prihodki:** ${p.finance.revenue}`,
    `- **Zaposleni:** ${p.finance.employees}`,
    `- **Izvoz / globalna prisotnost:** ${p.finance.exportShare}`,
    "",
    "### 3. Produktni fokus in tehnologija",
    `- **Linije in materiali:** ${p.product.lines}`,
    `- **Certifikati / tehnologija:** ${p.product.techCerts}`,
    `- **Proizvodni model:** ${p.product.productionModel}`,
    "",
    "### 4. Tržno pozicioniranje",
    `- **Cenovni segment:** ${p.positioning.priceTier}`,
    `- **USP:** ${p.positioning.usp}`,
    `- **Ciljna skupina:** ${p.positioning.target}`,
    "",
    "### 5. Prisotnost in distribucija v Sloveniji",
    `- **Model vstopa:** ${p.distributionSi.entryModel}`,
    `- **Partnerji / trgovine:** ${p.distributionSi.partners}`,
    "",
  ].join("\n");
}

let total = 0;
for (const cat of WOOD_CATEGORIES) {
  const lines: string[] = [];
  lines.push(
    `# ${String(cat.number).padStart(2, "0")} — ${cat.title}`,
    "",
    "## Primerjalna tabela",
    "",
  );
  lines.push(
    "| Znamka | Izvor | Cenovni razred | Glavni USP | Prisotnost v SLO |",
  );
  lines.push("| --- | --- | --- | --- | --- |");
  for (const b of cat.brands) {
    lines.push(
      `| ${mdEscape(b.name)} | ${ORIGIN_LABELS[b.origin]} | ${mdEscape(b.priceTier)} | ${mdEscape(b.usp)} | ${mdEscape(b.presenceSi)} |`,
    );
  }
  lines.push("", "---", "");
  for (const origin of origins) {
    const group = cat.brands.filter((b) => b.origin === origin);
    if (!group.length) continue;
    lines.push(`# ${ORIGIN_LABELS[origin]}`, "");
    for (const b of group) lines.push(brandSection(b));
  }
  writeFileSync(`raziskava_lesna_industrija/${cat.slug}.md`, lines.join("\n"));
  total += cat.brands.length;
  console.log(cat.slug, cat.brands.length);
}
console.log("total", total);
