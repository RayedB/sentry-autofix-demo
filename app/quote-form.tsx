"use client";

import { useState, type FormEvent } from "react";
import { COFFEES } from "@/lib/catalog";
import { formatDollars } from "@/lib/format";
import type { Quote } from "@/lib/pricing";

type View =
  | { status: "idle" }
  | { status: "invalid"; message: string }
  | { status: "failed" }
  | { status: "quoted"; quote: Quote };

function isQuote(value: unknown): value is Quote {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const quote = value as Partial<Quote>;
  return (
    typeof quote.total === "number" &&
    typeof quote.subtotal === "number" &&
    typeof quote.delivery === "number" &&
    typeof quote.deliveryLabel === "string" &&
    Array.isArray(quote.lines)
  );
}

function isMessage(value: unknown): value is { message: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof (value as { message?: unknown }).message === "string";
}

function QuotePanel({ view }: { view: View }) {
  switch (view.status) {
    case "idle":
      return null;
    case "invalid":
      return (
        <p className="message" role="alert">
          {view.message}
        </p>
      );
    case "failed":
      return (
        <p className="message" role="alert">
          We could not price that order. Try again in a moment.
        </p>
      );
    case "quoted":
      return (
        <section className="quote" aria-labelledby="quote-heading" aria-live="polite">
          <h2 id="quote-heading">Quote</h2>
          <ul>
            {view.quote.lines.map((line) => (
              <li key={line.sku}>
                <span>
                  {line.name} × {line.quantity}
                </span>
                <span>{formatDollars(line.amount)}</span>
              </li>
            ))}
          </ul>
          <dl>
            <div>
              <dt>Subtotal</dt>
              <dd>{formatDollars(view.quote.subtotal)}</dd>
            </div>
            <div>
              <dt>Delivery · {view.quote.deliveryLabel}</dt>
              <dd>
                {view.quote.delivery === 0
                  ? "Free"
                  : formatDollars(view.quote.delivery)}
              </dd>
            </div>
            <div className="total">
              <dt>Total</dt>
              <dd>{formatDollars(view.quote.total)}</dd>
            </div>
          </dl>
        </section>
      );
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

export function QuoteForm() {
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<View>({ status: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = COFFEES.map((coffee) => ({
      sku: coffee.sku,
      quantity: Number(form.get(`qty.${coffee.sku}`)),
    }));
    const postalCode = String(form.get("postalCode") ?? "");

    setPending(true);
    try {
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines, postalCode }),
      });

      if (response.status === 400) {
        const body: unknown = await response.json();
        setView({
          status: "invalid",
          message: isMessage(body)
            ? body.message
            : "Check the order and try again.",
        });
        return;
      }

      if (!response.ok) {
        setView({ status: "failed" });
        return;
      }

      const body: unknown = await response.json();
      if (!isQuote(body)) {
        setView({ status: "failed" });
        return;
      }

      setView({ status: "quoted", quote: body });
    } catch {
      setView({ status: "failed" });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="order" onSubmit={onSubmit}>
      <h2>Order</h2>
      <div className="coffees">
        {COFFEES.map((coffee) => (
          <div className="coffee" key={coffee.sku}>
            <div>
              <label htmlFor={`qty-${coffee.sku}`}>{coffee.name}</label>
              <p>{coffee.detail}</p>
            </div>
            <p className="bag-price">{formatDollars(coffee.price)}</p>
            <input
              id={`qty-${coffee.sku}`}
              name={`qty.${coffee.sku}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={24}
              step={1}
              defaultValue={0}
            />
          </div>
        ))}
      </div>
      <label className="postal" htmlFor="postal-code">
        Postal code
        <input
          id="postal-code"
          name="postalCode"
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="94107"
          maxLength={5}
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Pricing..." : "Get quote"}
      </button>
      <QuotePanel view={view} />
    </form>
  );
}
