import type { Brand, BrandOrigin, PriceTier } from "../types";
import { brandLogoSrc } from "../logoManifest";

export type BrandSeed = {
  id: string;
  name: string;
  origin: BrandOrigin;
  companyUrl: string;
  sloveniaUrl: string | null;
  priceTier: PriceTier;
  usp: string;
  presenceSi: string;
  legalName: string;
  hq: string;
  founded: string;
  ownership: string;
  revenue: string;
  employees: string;
  exportShare: string;
  lines: string;
  techCerts: string;
  productionModel: string;
  target: string;
  entryModel: string;
  partners: string;
};

export function brand(s: BrandSeed): Brand {
  return {
    id: s.id,
    name: s.name,
    origin: s.origin,
    logoSrc: brandLogoSrc(s.id),
    companyUrl: s.companyUrl,
    sloveniaUrl: s.sloveniaUrl,
    priceTier: s.priceTier,
    usp: s.usp,
    presenceSi: s.presenceSi,
    profile: {
      identity: {
        legalName: s.legalName,
        hq: s.hq,
        founded: s.founded,
        ownership: s.ownership,
      },
      finance: {
        revenue: s.revenue,
        employees: s.employees,
        exportShare: s.exportShare,
      },
      product: {
        lines: s.lines,
        techCerts: s.techCerts,
        productionModel: s.productionModel,
      },
      positioning: {
        priceTier: s.priceTier,
        usp: s.usp,
        target: s.target,
      },
      distributionSi: {
        entryModel: s.entryModel,
        partners: s.partners,
      },
    },
  };
}
