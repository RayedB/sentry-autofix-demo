export const COFFEES = [
  {
    sku: "kenya",
    name: "Kenya Gichathaini",
    detail: "Nyeri · blackcurrant, grapefruit",
    price: 1800,
  },
  {
    sku: "guatemala",
    name: "Guatemala Huehuetenango",
    detail: "Huehuetenango · cocoa, orange",
    price: 1700,
  },
  {
    sku: "ethiopia",
    name: "Ethiopia Worka",
    detail: "Gedeb · jasmine, peach",
    price: 1900,
  },
] as const;

export type Sku = (typeof COFFEES)[number]["sku"];

export function isSku(value: unknown): value is Sku {
  return COFFEES.some((coffee) => coffee.sku === value);
}
