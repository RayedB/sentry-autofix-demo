import { QuoteForm } from "./quote-form";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="mast">
        <p className="mark">Northline Roasters</p>
        <h1>Wholesale bag quote</h1>
        <p className="lede">
          Price a standing order of roasted coffee. Delivery is free at $75.
        </p>
      </header>
      <QuoteForm />
      <footer>
        <p>Roasted to order in Oakland. Twelve-ounce bags.</p>
      </footer>
    </main>
  );
}
