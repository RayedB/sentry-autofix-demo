import { parseQuoteRequest, priceQuote } from "@/lib/pricing";
import { recordReplayContext } from "@/lib/sentry-replay";

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

  recordReplayContext(request, payload);

  const parsed = parseQuoteRequest(payload);
  if (!parsed.ok) {
    return Response.json({ message: parsed.message }, { status: 400 });
  }

  const quote = priceQuote(parsed.value);
  return Response.json(quote);
}
