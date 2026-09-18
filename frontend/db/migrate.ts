// Applies pending Drizzle migrations (frontend/drizzle/*.sql) to the
// database named by DATABASE_URL. Run with: npm run db:migrate
import "./load-env";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (see frontend/.env.example).");
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  console.log("Applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully.");

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
