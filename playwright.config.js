import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.TEST_PORT || "4399";
const DB_PATH = process.env.TEST_DB || "/tmp/rig-e2e-db.json";

// 无 root 环境：scripts/setup-browser.sh 把缺失的浏览器动态库解包到 .pw-libs，
// 这里把其中的多架构库目录加入 LD_LIBRARY_PATH，供 Chromium 启动时加载。
const localLibs = join(process.cwd(), ".pw-libs");
if (existsSync(localLibs)) {
  const extra = [];
  for (const root of ["lib", "usr/lib"]) {
    const dir = join(localLibs, root);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.includes("-linux-gnu")) extra.push(join(dir, entry));
    }
  }
  if (extra.length) {
    process.env.LD_LIBRARY_PATH = [...extra, process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");
  }
}

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/global-setup.js",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 8000
  },
  webServer: {
    command: `node server.js`,
    url: `http://localhost:${PORT}/`,
    timeout: 15000,
    reuseExistingServer: false,
    env: { PORT, DB_PATH }
  }
});
