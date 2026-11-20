import { expect, test } from "@playwright/test";

test("quotes a small order with local delivery", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Ethiopia Worka").fill("2");
  await page.getByLabel("Postal code").fill("94107");
  await page.getByRole("button", { name: "Get quote" }).click();

  const quote = page.getByRole("region", { name: "Quote" });
  await expect(quote).toBeVisible();
  await expect(quote.getByText("Ethiopia Worka × 2")).toBeVisible();
  await expect(quote.getByText("Delivery · San Francisco")).toBeVisible();
  await expect(quote.getByText("$6.00")).toBeVisible();
  await expect(quote.locator(".total")).toContainText("$44.00");
});

test("waives delivery at $75", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Kenya Gichathaini").fill("1");
  await page.getByLabel("Ethiopia Worka").fill("3");
  await page.getByLabel("Postal code").fill("94107");
  await page.getByRole("button", { name: "Get quote" }).click();

  const quote = page.getByRole("region", { name: "Quote" });
  await expect(quote).toBeVisible();
  await expect(quote.getByText("Delivery · Complimentary")).toBeVisible();
  await expect(quote.getByText("Free")).toBeVisible();
  await expect(quote.locator(".total")).toContainText("$75.00");
});
