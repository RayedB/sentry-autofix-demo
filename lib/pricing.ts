import { COFFEES, isSku, type Sku } from "./catalog";

const FREE_DELIVERY_CENTS = 7500;

type Zone = {
  label: string;
  cents: number;
};

const ZONES: Record<string, Zone> = {
  "940": { label: "Peninsula", cents: 600 },
  "941": { label: "San Francisco", cents: 600 },
  "945": { label: "East Bay", cents: 500 },
  "946": { label: "Oakland", cents: 500 },
  "947": { label: "Berkeley", cents: 500 },
  "948": { label: "Richmond", cents: 700 },
  "949": { label: "North Bay", cents: 800 },
};

const STANDARD_ZONE: Zone = { label: "Standard", cents: 1200 };

export type QuoteLine = {
  sku: Sku;
  name: string;
  quantity: number;
  amount: number;
};

export type Quote = {
  lines: QuoteLine[];
  subtotal: number;
  deliveryLabel: string;
  delivery: number;
  total: number;
};

export type QuoteRequest = {
  lines: Array<{ sku: Sku; quantity: number }>;
  postalCode: string;
};

export type ParseResult =
  | { ok: true; value: QuoteRequest }
  | { ok: false; message: string };

function deliveryFor(postalCode: string, subtotal: number): Zone {
  if (subtotal >= FREE_DELIVERY_CENTS) {
    return { label: "Complimentary", cents: 0 };
  }

  const prefix = postalCode.slice(0, 3);
  const zone = Object.hasOwn(ZONES, prefix) ? ZONES[prefix] : STANDARD_ZONE;
  return { label: zone.label, cents: zone.cents };
}

export function parseQuoteRequest(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Add at least one bag." };
  }

  const record = input as { lines?: unknown; postalCode?: unknown };
  if (!Array.isArray(record.lines)) {
    return { ok: false, message: "Add at least one bag." };
  }

  const quantities = new Map<Sku, number>();
  for (const coffee of COFFEES) {
    quantities.set(coffee.sku, 0);
  }

  for (const line of record.lines) {
    if (typeof line !== "object" || line === null) {
      return { ok: false, message: "Check the bag quantities." };
    }

    const sku = (line as { sku?: unknown }).sku;
    const quantity = (line as { quantity?: unknown }).quantity;
    if (!isSku(sku)) {
      return { ok: false, message: "Unknown coffee." };
    }
    if (
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      quantity > 24
    ) {
      return { ok: false, message: "Enter a quantity from 0 to 24." };
    }
    quantities.set(sku, quantity);
  }

  const lines = COFFEES.flatMap((coffee) => {
    const quantity = quantities.get(coffee.sku) ?? 0;
    return quantity > 0 ? [{ sku: coffee.sku, quantity }] : [];
  });

  if (lines.length === 0) {
    return { ok: false, message: "Add at least one bag." };
  }

  const postalCode =
    typeof record.postalCode === "string" ? record.postalCode.trim() : "";
  if (!/^\d{5}$/.test(postalCode)) {
    return { ok: false, message: "Enter a 5-digit postal code." };
  }

  return { ok: true, value: { lines, postalCode } };
}

export function priceQuote(request: QuoteRequest): Quote {
  const lines = request.lines.map((line) => {
    const coffee = COFFEES.find((item) => item.sku === line.sku);
    if (!coffee) {
      throw new Error("Unknown coffee.");
    }

    return {
      sku: coffee.sku,
      name: coffee.name,
      quantity: line.quantity,
      amount: coffee.price * line.quantity,
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const delivery = deliveryFor(request.postalCode, subtotal);

  return {
    lines,
    subtotal,
    deliveryLabel: delivery.label,
    delivery: delivery.cents,
    total: subtotal + delivery.cents,
  };
}
