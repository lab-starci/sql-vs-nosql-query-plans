export type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  tags: string[];
  createdAt: string;
};

export type Category = {
  slug: string;
  name: string;
  department: string;
};

export type Fixture = {
  generatedAt: string;
  seed: number;
  categories: Category[];
  products: Product[];
};

export type ShapeName = "point-lookup" | "range-scan" | "aggregate" | "join-lookup";

export type SummaryRow = {
  shape: ShapeName;
  postgresTimeMs: number;
  mongoTimeMs: number;
  winner: "PostgreSQL" | "MongoDB" | "Tie";
  postgresPlanFile: string;
  mongoPlanFile: string;
  postgresEvidence: string;
  mongoEvidence: string;
};
