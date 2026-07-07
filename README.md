# SQL vs NoSQL Query Plan Benchmark

This exercise mirrors one shared `fixture.json` into PostgreSQL and MongoDB, then captures real execution plans for four query shapes.

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
| Point lookup by id | 0.139 ms | 0 ms | MongoDB |
| Range scan on price | 2.478 ms | 6 ms | PostgreSQL |
| Aggregate by category | 4.607 ms | 11 ms | PostgreSQL |
| Join / lookup category | 2.444 ms | 75 ms | PostgreSQL |

Point lookup: PostgreSQL used `Index Scan` on the primary key, while MongoDB used `IDHACK` on `_id`; MongoDB wins this tiny lookup because its plan reported `0 ms`.

Range scan: PostgreSQL used `Bitmap Index Scan` on `idx_products_price`, while MongoDB used `IXSCAN` on `idx_products_price`; PostgreSQL wins on the captured execution time.

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
