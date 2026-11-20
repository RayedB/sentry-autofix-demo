import { parseQuoteRequest, priceQuote } from "@/lib/pricing";

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { message: "Send the coffees and a postal code." },
      { status: 400 },
    );
  }

  const parsed = parseQuoteRequest(payload);
  if (!parsed.ok) {
    return Response.json({ message: parsed.message }, { status: 400 });
  }

  const quote = priceQuote(parsed.value);
  return Response.json(quote);
}
