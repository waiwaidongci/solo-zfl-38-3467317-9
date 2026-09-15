import { test, expect, request as pwRequest } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const PORT = process.env.FAULT_PORT || "4411";
const DB_PATH = process.env.FAULT_DB || "/tmp/rig-fault-db.json";
const BASE = `http://localhost:${PORT}`;

async function api() {
  return pwRequest.newContext({ baseURL: BASE });
}
async function createShip(ctx, code) {
  const res = await ctx.post("/api/items", { data: { code, shipType: "福船", status: "待检查" } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id;
}
async function addNode(ctx, sid, n) {
  const res = await ctx.post(`/api/ships/${sid}/nodes`, { data: n });
  expect(res.ok(), await res.text()).toBeTruthy();
}
async function armFailures(n = 1) {
  await fetch(`${BASE}/api/test/faults`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ failSaves: n })
  });
}
function diskShip(sid) {
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  return db.items.find(x => x.id === sid);
}

test.beforeAll(async () => {
  globalThis.__fctx = await api();
});

/* ================= 保存失败：接口 / 内存 / 磁盘一致 ================= */
test("保存失败返回 500，内存与磁盘都没有部分记录，随后写入恢复", async ({ request }) => {
  const ctx = globalThis.__fctx;
  const sid = await createShip(ctx, "F-SAVE");
  await addNode(ctx, sid, { id: "M1", type: "桅杆", zone: "主桅" });

  // 让下一次 saveDb 抛错
  await armFailures(1);
  const failing = await request.post(`/api/ships/${sid}/nodes`, {
    data: { id: "GHOST", type: "滑轮", zone: "主桅" }
  });
  expect(failing.status()).toBe(500);
  const body = await failing.json();
  expect(body.error).toBe("EFAULT");

  // 内存（后续 GET 读到的是已提交状态）：没有 GHOST，M1 仍在
  const view = await (await request.get(`/api/ships/${sid}`)).json();
  expect(view.rig.nodes.map(n => n.id)).toEqual(["M1"]);

  // 磁盘：没有 GHOST，M1 仍在；没有遗留 .tmp
  expect(diskShip(sid).rig.nodes.map(n => n.id)).toEqual(["M1"]);
  expect(JSON.stringify(diskShip(sid))).not.toContain("GHOST");
  expect(existsSync(DB_PATH + ".tmp")).toBe(false);

  // 成功响应必须对应已落盘数据：故障计数已耗尽，下一次写入成功
  const ok = await request.post(`/api/ships/${sid}/nodes`, {
    data: { id: "REAL", type: "系点", zone: "主桅" }
  });
  expect(ok.status()).toBe(201);
  expect((await ok.json()).rig.nodes.map(n => n.id)).toEqual(["M1", "REAL"]);
  const view2 = await (await request.get(`/api/ships/${sid}`)).json();
  expect(view2.rig.nodes.map(n => n.id)).toEqual(["M1", "REAL"]);
  expect(diskShip(sid).rig.nodes.map(n => n.id)).toEqual(["M1", "REAL"]);
});

test("保存失败不影响并发队列中的后续写请求", async ({ request }) => {
  const ctx = globalThis.__fctx;
  const sid = await createShip(ctx, "F-QUEUE");
  await addNode(ctx, sid, { id: "N0", type: "桅杆", zone: "主桅" });
  await armFailures(1); // 只让第一次 saveDb 失败
  const results = await Promise.all(["Q1", "Q2", "Q3"].map(id =>
    request.post(`/api/ships/${sid}/nodes`, { data: { id, type: "系点", zone: "主桅" } })
  ));
  const statuses = results.map(r => r.status()).sort();
  // 恰好一个 500，另外两个 201
  expect(statuses).toEqual([201, 201, 500]);

  // 找出失败的那条索路：它不应出现在内存或磁盘
  const perReq = await Promise.all(results.map(async (r, i) => ({ id: ["Q1", "Q2", "Q3"][i], ok: r.ok() })));
  const failedId = perReq.find(x => !x.ok).id;
  const okIds = perReq.filter(x => x.ok).map(x => x.id).sort();

  const view = await (await request.get(`/api/ships/${sid}`)).json();
  const memIds = view.rig.nodes.map(n => n.id).sort();
  const diskIds = diskShip(sid).rig.nodes.map(n => n.id).sort();
  expect(memIds).toEqual(["N0", ...okIds]);
  expect(diskIds).toEqual(memIds);          // 内存与磁盘一致
  expect(diskIds).not.toContain(failedId);  // 失败的未落盘数据不在
});

/* ================= 保存失败：重启后结果一致（失败的数据不会“复活”） ================= */
test("保存失败后重启：未落盘数据仍然不存在，已落盘数据仍在", async ({ request }) => {
  const ctx = globalThis.__fctx;
  const sid = await createShip(ctx, "F-RESTART");
  await addNode(ctx, sid, { id: "K1", type: "桅杆", zone: "主桅" });
  await armFailures(1);
  const failing = await request.post(`/api/ships/${sid}/routes`, {
    data: { id: "GHOST-ROUTE", name: "幽灵索", start: "K1", end: "K1", via: [], targetZone: "主桅" }
  });
  expect(failing.status()).toBe(500);

  // 冷启动另一个进程读同一文件（不注入故障）
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "4412", DB_PATH },
    stdio: "ignore"
  });
  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch("http://localhost:4412/api/ships")).ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    const rep = await (await fetch(`http://localhost:4412/api/ships/${sid}/report`)).json();
    expect(rep.report.totalRoutes).toBe(0);
    const view = await (await fetch(`http://localhost:4412/api/ships/${sid}`)).json();
    expect(view.rig.nodes.map(n => n.id)).toEqual(["K1"]);
    expect(JSON.stringify(readFileSync(DB_PATH, "utf8"))).not.toContain("GHOST-ROUTE");
  } finally {
    child.kill("SIGTERM");
  }
});

/* ================= 真实浏览器：保存失败后页面与表单状态 ================= */
test("真实浏览器：保存失败时页面不出现新行、表单保留输入、刷新后状态一致", async ({ page }) => {
  const ctx = globalThis.__fctx;
  const sid = await createShip(ctx, "F-UI");
  await addNode(ctx, sid, { id: "M1", type: "桅杆", zone: "主桅" });

  await page.goto("/rig");
  await page.selectOption("#shipSelect", await page.$eval("#shipSelect", (sel, code) => {
    return [...sel.options].find(o => o.textContent.includes(code)).value;
  }, "F-UI"));

  // 登记一个会成功的节点，确认页面基线
  await page.fill("#nodeForm [name=id]", "B1");
  await page.selectOption("#nodeType", "滑轮");
  await page.fill("#nodeForm [name=zone]", "主桅");
  await page.click("#nodeForm button[type=submit]");
  await expect(page.locator('[data-del-node="B1"]')).toBeVisible();

  // 注入下一次保存失败
  await armFailures(1);

  // 用浏览器提交一个新节点 GHOST
  await page.fill("#nodeForm [name=id]", "GHOST");
  await page.selectOption("#nodeType", "滑轮");
  await page.fill("#nodeForm [name=zone]", "主桅");
  const respPromise = page.waitForResponse(r => r.url().includes("/nodes") && r.request().method() === "POST");
  await page.click("#nodeForm button[type=submit]");
  const resp = await respPromise;
  expect(resp.status()).toBe(500);

  // 错误提示明确，输入保留
  await expect(page.locator("#nodeError")).toContainText("提交失败");
  await expect(page.locator("#nodeError")).toContainText("页面数据未改动");
  await expect(page.locator("#nodeForm [name=id]")).toHaveValue("GHOST");

  // 页面节点表没有 GHOST，B1/M1 仍在
  await expect(page.locator('[data-del-node="GHOST"]')).toHaveCount(0);
  await expect(page.locator('[data-del-node="B1"]')).toHaveCount(1);
  await expect(page.locator('[data-del-node="M1"]')).toHaveCount(1);

  // 刷新页面：仍然没有 GHOST（内存里确实没有）
  await page.reload();
  await page.selectOption("#shipSelect", await page.$eval("#shipSelect", (sel, code) => {
    return [...sel.options].find(o => o.textContent.includes(code)).value;
  }, "F-UI"));
  await expect(page.locator('[data-del-node="GHOST"]')).toHaveCount(0);
  await expect(page.locator('[data-del-node="B1"]')).toHaveCount(1);

  // 磁盘复核
  expect(JSON.stringify(diskShip(sid))).not.toContain("GHOST");
  expect(diskShip(sid).rig.nodes.map(n => n.id).sort()).toEqual(["B1", "M1"]);

  // 故障恢复后，浏览器再提交成功，页面与磁盘都更新
  await page.fill("#nodeForm [name=id]", "REAL2");
  await page.selectOption("#nodeType", "系点");
  await page.fill("#nodeForm [name=zone]", "主桅");
  await page.click("#nodeForm button[type=submit]");
  await expect(page.locator('[data-del-node="REAL2"]')).toBeVisible();
  expect(diskShip(sid).rig.nodes.map(n => n.id).sort()).toEqual(["B1", "M1", "REAL2"]);
});
