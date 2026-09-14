import { rmSync } from "node:fs";

export default async function globalSetup() {
  const dbPath = process.env.TEST_DB || "/tmp/rig-e2e-db.json";
  for (const p of [dbPath, dbPath + ".tmp"]) {
    try { rmSync(p); } catch {}
  }
}
