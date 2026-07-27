import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const file = path.join(dataDir, "db.json");

// Ensure the data directory exists (it won't after a fresh git clone,
// since Git doesn't track empty folders) — otherwise lowdb crashes on write.
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const adapter = new JSONFile(file);
const defaultData = { orders: [], users: [] };
export const db = new Low(adapter, defaultData);

export async function initDb() {
  await db.read();
  db.data ||= defaultData;
  db.data.orders ||= [];
  db.data.users ||= [];
  await db.write();
}

// NOTE: lowdb (JSON file on disk) is perfect for a boutique doing dozens to a
// few thousand orders. If you outgrow it — high order volume, need multiple
// people writing at once, or want real SQL queries/reporting — swap this file
// for a Postgres connection (e.g. via `pg` or an ORM like Prisma) and keep the
// same exported `db.data.orders` shape so server.js doesn't need to change much.
