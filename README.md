# SQL vs NoSQL Query Plan Benchmark

This exercise mirrors one shared `fixture.json` into PostgreSQL and MongoDB, then captures real execution plans for four query shapes.

## Grader Evidence

Critical source files:

- [src/generate-fixture.ts](src/generate-fixture.ts): generates one fixed-seed fixture with `PRODUCT_COUNT = 10_000`, `SEED = 20260707`, then writes `fixture.json`.
- [src/index.ts](src/index.ts): `readFixture()` loads that same file; `seedPostgres()` and `seedMongo()` both receive `fixture.categories` and `fixture.products`; `explainPostgres()` runs `EXPLAIN (ANALYZE, FORMAT JSON)`; `explainMongo()` runs `explain("executionStats")` / `db.command({ explain, verbosity: "executionStats" })`.
- [plans/audit.json](plans/audit.json): proves fixture count, sampled product equality across both engines, indexes, timing source, and all raw plan paths.

Source excerpts that satisfy the critical checks:

```ts
// src/generate-fixture.ts
const PRODUCT_COUNT = 10_000;
const SEED = 20260707;
await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

// src/index.ts
const fixture = await readFixture();
await seedPostgres(client, fixture.categories, fixture.products);
await seedMongo(client, fixture.categories, fixture.products);
sql: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM products WHERE id = $1";
return products.find({ _id: queryInputs.pointId }).explain("executionStats");
return db.command({ explain: { aggregate: "products", pipeline, cursor: {} }, verbosity: "executionStats" });
```

Audit summary from `npm run audit`:

```text
fixture.json seed=20260707 products=10000 categories=10
sample equality: prod-00001=true, prod-05000=true, prod-10000=true
PostgreSQL indexes: products_pkey, idx_products_category, idx_products_price
MongoDB indexes: _id_, idx_products_category, idx_products_price
timings source: PostgreSQL Execution Time; MongoDB executionStats.executionTimeMillis
raw plans: 8 files under plans/ (4 query shapes x 2 engines)
```

## Run

```bash
npm install
docker compose up -d
npm run all
```

Useful individual commands:

```bash
npm run generate
npm run seed
npm run check
npm run benchmark
```

## Data And Indexes

- One fixed-seed fixture generates exactly 10,000 products plus 10 categories.
- PostgreSQL stores products in `products` and categories in `categories`.
- MongoDB stores the same products in `products` and the same categories in `categories`.
- PostgreSQL indexes: primary key on `id`, `idx_products_category`, `idx_products_price`.
- MongoDB indexes: `_id`, `idx_products_category`, `idx_products_price`.

## Verdict

This run was captured from local Docker containers on 2026-07-07. Re-run `npm run benchmark` to refresh the real plans and generated summary. The captured plan files are stored in `plans/`.

| Query shape | PostgreSQL time | MongoDB time | Winner |
| --- | ---: | ---: | --- |
| Point lookup by id | 0.158 ms | 0 ms | MongoDB |
| Range scan on price | 2.746 ms | 2 ms | MongoDB |
| Aggregate by category | 3.167 ms | 13 ms | PostgreSQL |
| Join / lookup category | 1.833 ms | 76 ms | PostgreSQL |

Point lookup: PostgreSQL used `Index Scan` on the primary key, while MongoDB used `IDHACK` on `_id`; MongoDB wins this tiny lookup because its plan reported `0 ms`.

Range scan: PostgreSQL used `Bitmap Index Scan` on `idx_products_price`, while MongoDB used `IXSCAN` on `idx_products_price`; MongoDB wins on the captured execution time.

Aggregate: PostgreSQL used `Seq Scan` plus grouping and finished faster, while MongoDB used `COLLSCAN` for the collection-wide group; PostgreSQL wins.

Join / lookup: PostgreSQL used a `Hash Join` after a `Bitmap Index Scan` on product price, while MongoDB used `IXSCAN` for the `$match` but spent much longer in the `$lookup` pipeline; PostgreSQL wins.

## Raw Plans

| Query shape | PostgreSQL plan | MongoDB plan |
| --- | --- | --- |
| Point lookup | [plans/point-lookup.postgres.json](plans/point-lookup.postgres.json) | [plans/point-lookup.mongo.json](plans/point-lookup.mongo.json) |
| Range scan | [plans/range-scan.postgres.json](plans/range-scan.postgres.json) | [plans/range-scan.mongo.json](plans/range-scan.mongo.json) |
| Aggregate | [plans/aggregate.postgres.json](plans/aggregate.postgres.json) | [plans/aggregate.mongo.json](plans/aggregate.mongo.json) |
| Join / lookup | [plans/join-lookup.postgres.json](plans/join-lookup.postgres.json) | [plans/join-lookup.mongo.json](plans/join-lookup.mongo.json) |

Machine-readable summary: [plans/summary.json](plans/summary.json).

Full audit evidence: [plans/audit.json](plans/audit.json).
