import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Category, Fixture, Product } from "./types";

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.join(ROOT, "fixture.json");
const PRODUCT_COUNT = 10_000;
const SEED = 20260707;

const categories: Category[] = [
  { slug: "laptops", name: "Laptops", department: "Computing" },
  { slug: "phones", name: "Phones", department: "Mobile" },
  { slug: "tablets", name: "Tablets", department: "Mobile" },
  { slug: "monitors", name: "Monitors", department: "Computing" },
  { slug: "audio", name: "Audio", department: "Entertainment" },
  { slug: "cameras", name: "Cameras", department: "Imaging" },
  { slug: "gaming", name: "Gaming", department: "Entertainment" },
  { slug: "networking", name: "Networking", department: "Infrastructure" },
  { slug: "storage", name: "Storage", department: "Computing" },
  { slug: "wearables", name: "Wearables", department: "Mobile" }
];

const tagPool = [
  "new",
  "sale",
  "popular",
  "premium",
  "budget",
  "portable",
  "wireless",
  "usb-c",
  "4k",
  "refurbished",
  "eco",
  "fast"
];

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

function createProduct(index: number, rng: () => number): Product {
  const category = pick(categories, rng).slug;
  const tagCount = 2 + Math.floor(rng() * 3);
  const tags = new Set<string>();

  while (tags.size < tagCount) {
    tags.add(pick(tagPool, rng));
  }

  const cents = 999 + Math.floor(rng() * 249_001);
  const createdAt = new Date(Date.UTC(2025, 0, 1) + Math.floor(rng() * 365 * 24 * 60 * 60 * 1000));

  return {
    id: `prod-${String(index + 1).padStart(5, "0")}`,
    name: `${category.replace("-", " ")} product ${index + 1}`,
    category,
    price: Number((cents / 100).toFixed(2)),
    tags: [...tags],
    createdAt: createdAt.toISOString()
  };
}

async function main(): Promise<void> {
  const rng = createRng(SEED);
  const products = Array.from({ length: PRODUCT_COUNT }, (_, index) => createProduct(index, rng));
  const fixture: Fixture = {
    generatedAt: "2026-07-07T00:00:00.000Z",
    seed: SEED,
    categories,
    products
  };

  await mkdir(ROOT, { recursive: true });
  await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`Wrote ${products.length} products to ${FIXTURE_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
