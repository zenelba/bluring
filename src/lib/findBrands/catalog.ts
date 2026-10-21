import type { BrandArea } from "./types";
import { WOOD_CATEGORIES } from "./wood/brands";

export const FIND_BRANDS_AREAS: ReadonlyArray<BrandArea> = [
  {
    id: "lesna-industrija",
    title: "Lesna in pohištvena industrija",
    blurb:
      "7 kategorij blagovnih znamk — logotipi, URLji in raziskovalni profili",
    categories: WOOD_CATEGORIES,
  },
];

export function getArea(areaId: string) {
  return FIND_BRANDS_AREAS.find((a) => a.id === areaId) ?? null;
}

export function getCategory(areaId: string, categoryId: string) {
  const area = getArea(areaId);
  return area?.categories.find((c) => c.id === categoryId) ?? null;
}

export function getBrand(areaId: string, categoryId: string, brandId: string) {
  const category = getCategory(areaId, categoryId);
  return category?.brands.find((b) => b.id === brandId) ?? null;
}
