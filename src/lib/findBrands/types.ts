/** Find Brands catalog types — areas, categories, brand profiles. */

export type BrandOrigin = "si" | "foreign_in_si" | "eu_strong";

export type PriceTier =
  | "Dostopni"
  | "Srednji"
  | "Višji-srednji"
  | "Premijski"
  | "Luksuz";

export type BrandIdentity = {
  legalName: string;
  hq: string;
  founded: string;
  ownership: string;
};

export type BrandFinance = {
  revenue: string;
  employees: string;
  exportShare: string;
};

export type BrandProduct = {
  lines: string;
  techCerts: string;
  productionModel: string;
};

export type BrandPositioning = {
  priceTier: PriceTier;
  usp: string;
  target: string;
};

export type BrandDistributionSi = {
  entryModel: string;
  partners: string;
};

export type BrandProfile = {
  identity: BrandIdentity;
  finance: BrandFinance;
  product: BrandProduct;
  positioning: BrandPositioning;
  distributionSi: BrandDistributionSi;
};

export type Brand = {
  id: string;
  name: string;
  origin: BrandOrigin;
  logoSrc: string;
  companyUrl: string;
  sloveniaUrl: string | null;
  priceTier: PriceTier;
  usp: string;
  presenceSi: string;
  profile: BrandProfile;
};

export type BrandCategory = {
  id: string;
  number: number;
  title: string;
  slug: string;
  brands: ReadonlyArray<Brand>;
};

export type BrandArea = {
  id: string;
  title: string;
  blurb: string;
  categories: ReadonlyArray<BrandCategory>;
};

export const ORIGIN_LABELS: Record<BrandOrigin, string> = {
  si: "Slovenske",
  foreign_in_si: "Tuje v SLO",
  eu_strong: "Močne evropske",
};

export const ORIGIN_ORDER: BrandOrigin[] = ["si", "foreign_in_si", "eu_strong"];
