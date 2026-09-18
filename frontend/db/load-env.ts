// Loads frontend/.env.local for standalone scripts (migrate, seed,
// verification) that run outside the Next.js runtime, which loads
// .env.local automatically on its own. Import this before anything
// that reads process.env.DATABASE_URL.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(process.cwd(), ".env.local") });
