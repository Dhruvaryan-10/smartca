// SmartCA — Drizzle client.
//
// DATABASE_URL is read from the environment only. It must never be
// hardcoded here or anywhere else in source. Locally it comes from
// frontend/.env.local (gitignored); in a deployed environment it is
// set as a real environment variable.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy frontend/.env.example to " +
    "frontend/.env.local and set DATABASE_URL to your local PostgreSQL " +
    "connection string."
  );
}

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });
