import { rmSync } from "node:fs";

export default async function globalSetup() {
  const paths = [
    process.env.TEST_DB || "/tmp/rig-e2e-db.json",
    process.env.FAULT_DB || "/tmp/rig-fault-db.json"
  ];
  for (const base of paths) {
    for (const p of [base, base + ".tmp"]) {
      try { rmSync(p); } catch {}
    }
  }
}
