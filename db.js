import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "data", "db.json");

const adapter = new JSONFile(file);
const defaultData = { orders: [] };
export const db = new Low(adapter, defaultData);

export async function initDb() {
  await db.read();
  db.data ||= defaultData;
  await db.write();
}

// NOTE: lowdb (JSON file on disk) is perfect for a boutique doing dozens to a
// few thousand orders. If you outgrow it — high order volume, need multiple
// people writing at once, or want real SQL queries/reporting — swap this file
// for a Postgres connection (e.g. via `pg` or an ORM like Prisma) and keep the
// same exported `db.data.orders` shape so server.js doesn't need to change much.
