/** Auto-generated: brands with a usable PNG logo in public/find-brands/logos. */
export const BRANDS_WITH_PNG = new Set<string>([
  "alples",
  "artisan",
  "brio",
  "dankuchen",
  "grimms",
  "hasslacher",
  "josko",
  "kager-hise",
  "kay-bojesen",
  "kneer-sudfenster",
  "listone-giordano",
  "pirnar",
  "prostoria",
  "rex-kralj",
  "riko-hise",
  "riva-1920",
  "schueller-next125",
  "stora-enso",
  "svea",
  "swiss-krono",
  "tarkett",
  "woodupp",
]);

export function brandLogoSrc(id: string): string {
  return BRANDS_WITH_PNG.has(id)
    ? `/find-brands/logos/${id}.png`
    : `/find-brands/logos/${id}.svg`;
}
