import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";
import { Client as PgClient } from "pg";
import type { Category, Fixture, Product, ShapeName, SummaryRow } from "./types";

type ProductDocument = Omit<Product, "createdAt"> & {
  _id: string;
  createdAt: Date;
};

type CategoryDocument = Category & {
  _id: string;
};

type AuditSample = {
  id: string;
  fixture: Product;
  postgres: Product;
  mongo: Product;
  matches: boolean;
};

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.join(ROOT, "fixture.json");
const PLANS_DIR = path.join(ROOT, "plans");
const SUMMARY_PATH = path.join(PLANS_DIR, "summary.json");

const PG_CONNECTION = process.env.PG_CONNECTION ?? "postgres://benchmark:benchmark@localhost:5432/benchmark";
const MONGO_CONNECTION = process.env.MONGO_CONNECTION ?? "mongodb://benchmark:benchmark@localhost:27017/benchmark?authSource=admin";
const MONGO_DB = process.env.MONGO_DB ?? "benchmark";

const queryInputs = {
  pointId: "prod-05000",
  minPrice: 250,
  maxPrice: 750
};

const sampleIds = ["prod-00001", "prod-05000", "prod-10000"];

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as Fixture;
}

async function withPg<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = new PgClient({ connectionString: PG_CONNECTION });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withMongo<T>(fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(MONGO_CONNECTION);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function seedPostgres(client: PgClient, categories: Category[], products: Product[]): Promise<void> {
  await client.query("DROP TABLE IF EXISTS products");
  await client.query("DROP TABLE IF EXISTS categories");
  await client.query(`
    CREATE TABLE categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL REFERENCES categories(slug),
      price NUMERIC(10, 2) NOT NULL,
      tags JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);

  for (const category of categories) {
    await client.query(
      "INSERT INTO categories (slug, name, department) VALUES ($1, $2, $3)",
      [category.slug, category.name, category.department]
    );
  }

  const batchSize = 1000;
  for (let start = 0; start < products.length; start += batchSize) {
    const batch = products.slice(start, start + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((product, index) => {
      const offset = index * 6;
      values.push(product.id, product.name, product.category, product.price, JSON.stringify(product.tags), product.createdAt);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6})`;
    });
    await client.query(
      `INSERT INTO products (id, name, category, price, tags, created_at) VALUES ${placeholders.join(", ")}`,
      values
    );
  }

  await client.query("CREATE INDEX idx_products_category ON products(category)");
  await client.query("CREATE INDEX idx_products_price ON products(price)");
  await client.query("ANALYZE categories");
  await client.query("ANALYZE products");
}

async function seedMongo(client: MongoClient, categories: Category[], products: Product[]): Promise<void> {
  const db = client.db(MONGO_DB);
  await db.collection("products").drop().catch(() => undefined);
  await db.collection<CategoryDocument>("categories").drop().catch(() => undefined);

  await db.collection<CategoryDocument>("categories").insertMany(categories.map((category) => ({ _id: category.slug, ...category })));
  await db.collection<ProductDocument>("products").insertMany(
    products.map((product) => ({
      _id: product.id,
      ...product,
      createdAt: new Date(product.createdAt)
    })),
    { ordered: false }
  );

  await db.collection<ProductDocument>("products").createIndex({ category: 1 }, { name: "idx_products_category" });
  await db.collection<ProductDocument>("products").createIndex({ price: 1 }, { name: "idx_products_price" });
}

async function seed(): Promise<void> {
  const fixture = await readFixture();
  await withPg((client) => seedPostgres(client, fixture.categories, fixture.products));
  await withMongo((client) => seedMongo(client, fixture.categories, fixture.products));
  await check();
}

async function check(): Promise<void> {
  const fixture = await readFixture();
  const pgCount = await withPg(async (client) => {
    const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM products");
    return Number(result.rows[0].count);
  });
  const mongoCount = await withMongo((client) => client.db(MONGO_DB).collection<ProductDocument>("products").countDocuments());

  if (pgCount !== fixture.products.length || mongoCount !== fixture.products.length || pgCount !== mongoCount) {
    throw new Error(`Count mismatch: fixture=${fixture.products.length}, postgres=${pgCount}, mongo=${mongoCount}`);
  }

  console.log(`Counts match: fixture=${fixture.products.length}, postgres=${pgCount}, mongo=${mongoCount}`);
}

async function audit(): Promise<void> {
  const fixture = await readFixture();
  const fixtureById = new Map(fixture.products.map((product) => [product.id, product]));

  const pgRows = await withPg(async (client) => {
    const result = await client.query<{
      id: string;
      name: string;
      category: string;
      price: string;
      tags: string[];
      created_at: Date;
    }>(
      "SELECT id, name, category, price::text, tags, created_at FROM products WHERE id = ANY($1) ORDER BY id",
      [sampleIds]
    );

    return result.rows.map<Product>((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      price: Number(row.price),
      tags: row.tags,
      createdAt: row.created_at.toISOString()
    }));
  });

  const mongoRows = await withMongo(async (client) => {
    const rows = await client
      .db(MONGO_DB)
      .collection<ProductDocument>("products")
      .find({ _id: { $in: sampleIds } })
      .sort({ _id: 1 })
      .toArray();

    return rows.map<Product>((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      price: row.price,
      tags: row.tags,
      createdAt: row.createdAt.toISOString()
    }));
  });

  const samples: AuditSample[] = sampleIds.map((id) => {
    const fixtureProduct = fixtureById.get(id);
    const postgres = pgRows.find((row) => row.id === id);
    const mongo = mongoRows.find((row) => row.id === id);

    if (!fixtureProduct || !postgres || !mongo) {
      throw new Error(`Missing sampled product ${id}`);
    }

    return {
      id,
      fixture: fixtureProduct,
      postgres,
      mongo,
      matches:
        JSON.stringify(fixtureProduct) === JSON.stringify(postgres) &&
        JSON.stringify(fixtureProduct) === JSON.stringify(mongo)
    };
  });

  const pgIndexes = await withPg(async (client) => {
    const result = await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'products' ORDER BY indexname"
    );
    return result.rows;
  });

  const mongoIndexes = await withMongo((client) =>
    client.db(MONGO_DB).collection<ProductDocument>("products").indexes()
  );

  const summary = JSON.parse(await readFile(SUMMARY_PATH, "utf8")) as SummaryRow[];
  const report = {
    fixture: {
      file: "fixture.json",
      seed: fixture.seed,
      productCount: fixture.products.length,
      categoryCount: fixture.categories.length
    },
    sharedFixtureSamples: samples,
    indexes: {
      postgres: pgIndexes,
      mongo: mongoIndexes.map((index) => ({ name: index.name, key: index.key }))
    },
    planCapture: {
      postgres: "EXPLAIN (ANALYZE, FORMAT JSON)",
      mongo: "explain('executionStats') / db.command({ explain, verbosity: 'executionStats' })",
      timingsSource: "PostgreSQL Execution Time and MongoDB executionStats.executionTimeMillis",
      rawPlanFiles: summary.flatMap((row) => [row.postgresPlanFile, row.mongoPlanFile])
    },
    verdictSummary: summary
  };

  await writeJson("audit.json", report);
  console.log(JSON.stringify(report, null, 2));
}

function pgTimeMs(plan: unknown): number {
  const root = plan as Array<{ "Execution Time"?: number; Plan?: { "Actual Total Time"?: number } }>;
  return Number(root[0]?.["Execution Time"] ?? root[0]?.Plan?.["Actual Total Time"] ?? 0);
}

function mongoTimeMs(plan: unknown): number {
  const direct = plan as { executionStats?: { executionTimeMillis?: number } };
  if (typeof direct.executionStats?.executionTimeMillis === "number") {
    return direct.executionStats.executionTimeMillis;
  }

  const queue: unknown[] = [plan];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }

    const candidate = current as { executionStats?: { executionTimeMillis?: number } };
    if (typeof candidate.executionStats?.executionTimeMillis === "number") {
      return candidate.executionStats.executionTimeMillis;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return 0;
}

function collectStages(value: unknown, stages = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") {
    return stages;
  }

  for (const [key, child] of Object.entries(value)) {
    if ((key === "Node Type" || key === "stage") && typeof child === "string") {
      stages.add(child);
    }
    collectStages(child, stages);
  }

  return stages;
}

function evidence(plan: unknown): string {
  const stages = [...collectStages(plan)];
  const important = stages.filter((stage) =>
    ["Index Scan", "Bitmap Index Scan", "Seq Scan", "IXSCAN", "COLLSCAN", "IDHACK", "Hash Join", "Nested Loop", "EQ_LOOKUP"].includes(stage)
  );
  return important.length > 0 ? important.join(", ") : stages.slice(0, 5).join(", ");
}

async function explainPostgres(client: PgClient, shape: ShapeName): Promise<unknown> {
  const queries: Record<ShapeName, { sql: string; params?: unknown[] }> = {
    "point-lookup": {
      sql: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM products WHERE id = $1",
      params: [queryInputs.pointId]
    },
    "range-scan": {
      sql: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM products WHERE price BETWEEN $1 AND $2 ORDER BY price",
      params: [queryInputs.minPrice, queryInputs.maxPrice]
    },
    aggregate: {
      sql: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT category, count(*)::int AS product_count, avg(price) AS avg_price FROM products GROUP BY category ORDER BY category"
    },
    "join-lookup": {
      sql: `
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT p.id, p.name, p.price, c.name AS category_name, c.department
        FROM products p
        JOIN categories c ON c.slug = p.category
        WHERE p.price BETWEEN $1 AND $2
        ORDER BY p.price
      `,
      params: [queryInputs.minPrice, queryInputs.maxPrice]
    }
  };

  const result = await client.query(queries[shape].sql, queries[shape].params ?? []);
  return result.rows[0]["QUERY PLAN"];
}

async function explainMongo(client: MongoClient, shape: ShapeName): Promise<unknown> {
  const db = client.db(MONGO_DB);
  const products = db.collection<ProductDocument>("products");

  if (shape === "point-lookup") {
    return products.find({ _id: queryInputs.pointId }).explain("executionStats");
  }

  if (shape === "range-scan") {
    return products
      .find({ price: { $gte: queryInputs.minPrice, $lte: queryInputs.maxPrice } })
      .sort({ price: 1 })
      .explain("executionStats");
  }

  const pipeline =
    shape === "aggregate"
      ? [
          { $group: { _id: "$category", productCount: { $sum: 1 }, avgPrice: { $avg: "$price" } } },
          { $sort: { _id: 1 } }
        ]
      : [
          { $match: { price: { $gte: queryInputs.minPrice, $lte: queryInputs.maxPrice } } },
          {
            $lookup: {
              from: "categories",
              localField: "category",
              foreignField: "_id",
              as: "categoryDetails"
            }
          },
          { $unwind: "$categoryDetails" },
          { $sort: { price: 1 } },
          { $project: { id: 1, name: 1, price: 1, categoryDetails: 1 } }
        ];

  return db.command({
    explain: {
      aggregate: "products",
      pipeline,
      cursor: {}
    },
    verbosity: "executionStats"
  });
}

async function writeJson(fileName: string, value: unknown): Promise<string> {
  await mkdir(PLANS_DIR, { recursive: true });
  const filePath = path.join(PLANS_DIR, fileName);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

async function benchmark(): Promise<void> {
  const shapes: ShapeName[] = ["point-lookup", "range-scan", "aggregate", "join-lookup"];
  const rows: SummaryRow[] = [];

  await withPg(async (pg) => {
    await withMongo(async (mongo) => {
      for (const shape of shapes) {
        const pgPlan = await explainPostgres(pg, shape);
        const mongoPlan = await explainMongo(mongo, shape);
        const postgresTimeMs = pgTimeMs(pgPlan);
        const mongoTimeValueMs = mongoTimeMs(mongoPlan);
        const winner =
          Math.abs(postgresTimeMs - mongoTimeValueMs) < 0.001
            ? "Tie"
            : postgresTimeMs < mongoTimeValueMs
              ? "PostgreSQL"
              : "MongoDB";

        rows.push({
          shape,
          postgresTimeMs,
          mongoTimeMs: mongoTimeValueMs,
          winner,
          postgresPlanFile: await writeJson(`${shape}.postgres.json`, pgPlan),
          mongoPlanFile: await writeJson(`${shape}.mongo.json`, mongoPlan),
          postgresEvidence: evidence(pgPlan),
          mongoEvidence: evidence(mongoPlan)
        });
      }
    });
  });

  await writeJson("summary.json", rows);
  console.table(rows.map(({ shape, postgresTimeMs, mongoTimeMs, winner }) => ({ shape, postgresTimeMs, mongoTimeMs, winner })));
  console.log(`Summary written to ${SUMMARY_PATH}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "seed") {
    await seed();
    return;
  }
  if (command === "benchmark") {
    await benchmark();
    return;
  }
  if (command === "check") {
    await check();
    return;
  }
  if (command === "audit") {
    await audit();
    return;
  }

  console.log("Usage: npm run generate | npm run seed | npm run benchmark | npm run check | npm run audit | npm run all");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
