import { describe, expect, it } from "vitest";
import { parseQuoteRequest, priceQuote } from "./pricing";

describe("priceQuote", () => {
  it("adds San Francisco delivery for a small order", () => {
    const quote = priceQuote({
      lines: [{ sku: "ethiopia", quantity: 2 }],
      postalCode: "94107",
    });

    expect(quote).toEqual({
      lines: [
        {
          sku: "ethiopia",
          name: "Ethiopia Worka",
          quantity: 2,
          amount: 3800,
        },
      ],
      subtotal: 3800,
      deliveryLabel: "San Francisco",
      delivery: 600,
      total: 4400,
    });
  });

  it("waives delivery once the order reaches $75", () => {
    const quote = priceQuote({
      lines: [
        { sku: "kenya", quantity: 1 },
        { sku: "ethiopia", quantity: 3 },
      ],
      postalCode: "94107",
    });

    expect(quote.subtotal).toBe(7500);
    expect(quote.deliveryLabel).toBe("Complimentary");
    expect(quote.delivery).toBe(0);
    expect(quote.total).toBe(7500);
  });
});

describe("parseQuoteRequest", () => {
  it("rejects an order with no bags", () => {
    expect(
      parseQuoteRequest({
        lines: [
          { sku: "kenya", quantity: 0 },
          { sku: "guatemala", quantity: 0 },
          { sku: "ethiopia", quantity: 0 },
        ],
        postalCode: "94107",
      }),
    ).toEqual({ ok: false, message: "Add at least one bag." });
  });

  it("rejects a postal code that is not five digits", () => {
    expect(
      parseQuoteRequest({
        lines: [{ sku: "ethiopia", quantity: 1 }],
        postalCode: "9410",
      }),
    ).toEqual({ ok: false, message: "Enter a 5-digit postal code." });
  });

  it("accepts a small local order", () => {
    expect(
      parseQuoteRequest({
        lines: [{ sku: "ethiopia", quantity: 2 }],
        postalCode: "94107",
      }),
    ).toEqual({
      ok: true,
      value: {
        lines: [{ sku: "ethiopia", quantity: 2 }],
        postalCode: "94107",
      },
    });
  });
});
