import { test, expect, request as pwRequest } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = process.env.TEST_PORT || "4399";
const DB_PATH = process.env.TEST_DB || "/tmp/rig-e2e-db.json";
const BASE = `http://localhost:${PORT}`;

/* ---------- API 辅助（真实浏览器测试之外的数据装配，走同一 HTTP 服务） ---------- */
async function api() {
  return pwRequest.newContext({ baseURL: BASE });
}
async function createShip(ctx, code, shipType = "福船") {
  const res = await ctx.post("/api/items", { data: { code, shipType, status: "待检查" } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id;
}
async function addNode(ctx, sid, n) {
  const res = await ctx.post(`/api/ships/${sid}/nodes`, { data: n });
  expect(res.ok(), `addNode ${n.id}: ${await res.text()}`).toBeTruthy();
}
async function addLink(ctx, sid, from, to) {
  const res = await ctx.post(`/api/ships/${sid}/links`, { data: { from, to } });
  expect(res.ok(), `addLink ${from}->${to}: ${await res.text()}`).toBeTruthy();
}
async function submitRouteUI(page, route) {
  await page.fill("#routeForm [name=rid]", route.id);
  await page.fill("#routeForm [name=name]", route.name);
  await page.selectOption("#routeStart", route.start);
  await page.selectOption("#routeEnd", route.end);
  if (route.via) await page.fill("#routeForm [name=via]", route.via);
  if (route.targetZone) await page.fill("#routeForm [name=targetZone]", route.targetZone);
  const p = page.waitForResponse(r => r.url().includes("/routes") && r.request().method() === "POST");
  await page.click("#routeForm button[type=submit]");
  return p;
}
async function openShip(page, code) {
  await page.goto("/rig");
  const val = await page.$eval("#shipSelect", (sel, code) => {
    const o = [...sel.options].find(o => o.textContent.includes(code));
    return o.value;
  }, code);
  await page.selectOption("#shipSelect", val);
}

test.beforeAll(async () => {
  globalThis.__ctx = await api();
});

/* ================= 正确路径（全程页面操作） ================= */
test("正确索路：页面登记节点/连接/索路后显示可装配", async ({ page }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-OK");

  await openShip(page, "E2E-OK");

  // 页面登记 3 个节点
  for (const n of [
    { id: "M1", type: "桅杆", zone: "主桅" },
    { id: "B1", type: "滑轮", zone: "主桅" },
    { id: "T1", type: "系点", zone: "主桅" }
  ]) {
    await page.fill("#nodeForm [name=id]", n.id);
    await page.selectOption("#nodeType", n.type);
    await page.fill("#nodeForm [name=zone]", n.zone);
    await page.click("#nodeForm button[type=submit]");
    await expect(page.locator(`[data-del-node="${n.id}"]`)).toBeVisible();
    await expect(page.locator("#nodeError")).toBeEmpty();
  }

  // 页面登记两条允许连接关系（每次等待保存完成、下拉重新填充后再登记下一条）
  for (const [from, to] of [["M1", "B1"], ["B1", "T1"]]) {
    await page.selectOption("#linkFrom", from);
    await page.selectOption("#linkTo", to);
    const p = page.waitForResponse(r => r.url().includes("/links") && r.request().method() === "POST");
    await page.click("#linkForm button[type=submit]");
    expect((await p).status()).toBe(201);
  }
  await expect(page.locator("#linkList")).toContainText("B1→T1");

  // 页面提交有向索路
  const resp = await submitRouteUI(page, { id: "L1", name: "主桅升帆索", start: "M1", end: "T1", via: "B1", targetZone: "主桅" });
  expect(resp.status()).toBe(201);

  await expect(page.locator("#stateOk")).toContainText("可装配");
  await expect(page.locator("#allClear")).toContainText("全部索路通过校验");
  await expect(page.locator("#blockList .issue")).toHaveCount(0);
  await expect(page.locator("#routeTable")).toContainText("通过");
  await expect(page.locator("svg")).toBeVisible();
  // 索路图存在绿色索路箭头
  expect(await page.locator("svg line[marker-end='url(#arrowok)']").count()).toBeGreaterThan(0);
});

/* ================= 六类错误，逐类用真实浏览器走通 ================= */
const ERROR_CASES = [
  {
    code: "E2E-DANGLING", label: "悬空端点", issue: "dangling",
    nodes: [
      { id: "M1", type: "桅杆", zone: "主桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "T1", type: "系点", zone: "主桅" }
    ],
    links: [["M1", "B1"], ["B1", "T1"]],
    // 先提交正确索路，再在页面删除终点节点，造成悬空
    good: { id: "L1", name: "悬空端点索", start: "M1", end: "T1", via: "B1", targetZone: "主桅" },
    breakBy: "delete-node:T1"
  },
  {
    code: "E2E-REPEAT", label: "重复经过", issue: "repeated",
    nodes: [
      { id: "M1", type: "桅杆", zone: "主桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "T1", type: "系点", zone: "主桅" }
    ],
    links: [["M1", "B1"], ["B1", "T1"]],
    route: { id: "L1", name: "重复经过索", start: "M1", end: "T1", via: "B1, B1", targetZone: "主桅" }
  },
  {
    code: "E2E-CROSS", label: "跨桅错接", issue: "cross_mast",
    nodes: [
      { id: "MF", type: "桅杆", zone: "前桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "TF", type: "系点", zone: "前桅" }
    ],
    links: [],
    route: { id: "L1", name: "跨桅错接索", start: "MF", end: "TF", via: "B1", targetZone: "前桅" }
  },
  {
    code: "E2E-JOINT", label: "接头不匹配", issue: "joint_mismatch",
    nodes: [
      { id: "M1", type: "桅杆", zone: "主桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "B2", type: "滑轮", zone: "主桅" },
      { id: "J1", type: "接头", zone: "主桅", jointType: "环扣" },
      { id: "J2", type: "接头", zone: "主桅", jointType: "卸扣" },
      { id: "T1", type: "系点", zone: "主桅" }
    ],
    links: [["M1", "B1"], ["B1", "J1"], ["J1", "B2"], ["B2", "T1"]],
    route: { id: "L1", name: "接头不匹配索", start: "M1", end: "T1", via: "B1, J1, J2, B2", targetZone: "主桅" }
  },
  {
    code: "E2E-REVERSE", label: "起终点倒置", issue: "reversed",
    nodes: [
      { id: "M1", type: "桅杆", zone: "主桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "T1", type: "系点", zone: "主桅" }
    ],
    links: [["M1", "B1"], ["B1", "T1"]],
    route: { id: "L1", name: "起终点倒置索", start: "T1", end: "M1", via: "B1", targetZone: "主桅" }
  },
  {
    code: "E2E-UNLINKED", label: "连接未登记", issue: "unlinked",
    nodes: [
      { id: "M1", type: "桅杆", zone: "主桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "T1", type: "系点", zone: "主桅" }
    ],
    // 只登记首段 M1→B1，缺后段 B1→T1
    links: [["M1", "B1"]],
    route: { id: "L1", name: "缺后段连接索", start: "M1", end: "T1", via: "B1", targetZone: "主桅" }
  },
  {
    code: "E2E-ZONE", label: "未回到目标桅区", issue: "wrong_zone",
    nodes: [
      { id: "M1", type: "桅杆", zone: "主桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "T1", type: "系点", zone: "主桅" }
    ],
    links: [["M1", "B1"], ["B1", "T1"]],
    route: { id: "L1", name: "未回目标桅区索", start: "M1", end: "T1", via: "B1", targetZone: "后桅" }
  }
];

for (const c of ERROR_CASES) {
  test(`错误类型：${c.label} 被标出索位与原因`, async ({ page }) => {
    const ctx = globalThis.__ctx;
    const sid = await createShip(ctx, c.code);
    for (const n of c.nodes) await addNode(ctx, sid, n);
    for (const [from, to] of c.links) await addLink(ctx, sid, from, to);

    await openShip(page, c.code);

    if (c.breakBy === "delete-node:T1") {
      await submitRouteUI(page, c.good);
      await expect(page.locator("#stateOk")).toContainText("可装配");
      page.once("dialog", d => d.accept());
      await page.click('[data-del-node="T1"]');
      await page.waitForLoadState("networkidle");
    } else {
      await submitRouteUI(page, c.route);
    }

    // 阻断状态与该类问题卡片：标签 + 索位 + 原因
    await expect(page.locator("#stateBlock")).toContainText("阻断");
    const issue = page.locator(`.issue[data-issue="${c.issue}"]`).first();
    await expect(issue).toBeVisible();
    await expect(issue).toContainText(c.label);
    await expect(issue).toContainText("索位");
    await expect(issue).toContainText(c.breakBy ? c.good.name : c.route.name);
    // 索路表格同样标记不合格
    await expect(page.locator("#routeTable")).toContainText("项");
  });
}

/* ================= 按问题筛选 ================= */
test("阻断清单可按问题类型筛选", async ({ page }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-FILTER");
  for (const n of [
    { id: "M1", type: "桅杆", zone: "主桅" },
    { id: "B1", type: "滑轮", zone: "主桅" },
    { id: "T1", type: "系点", zone: "主桅" },
    { id: "T2", type: "系点", zone: "主桅" }
  ]) await addNode(ctx, sid, n);
  await addLink(ctx, sid, "M1", "B1");
  await addLink(ctx, sid, "B1", "T1");

  await openShip(page, "E2E-FILTER");
  await submitRouteUI(page, { id: "LR", name: "重复索", start: "M1", end: "T1", via: "B1, B1", targetZone: "主桅" });
  await submitRouteUI(page, { id: "LZ", name: "错区索", start: "M1", end: "T2", via: "B1", targetZone: "后桅" });

  await expect(page.locator(".route-block")).toHaveCount(2);
  await page.click('.chip.filter[data-type="repeated"]');
  await expect(page.locator(".route-block")).toHaveCount(1);
  await expect(page.locator(".route-block")).toContainText("重复索");
  await expect(page.locator('.issue[data-issue="repeated"]')).toHaveCount(1);
  await expect(page.locator('.issue[data-issue="wrong_zone"]')).toHaveCount(0);

  await page.click('.chip.filter[data-type="wrong_zone"]');
  await expect(page.locator(".route-block")).toHaveCount(1);
  await expect(page.locator(".route-block")).toContainText("错区索");

  await page.click('.chip.filter[data-type=""]');
  await expect(page.locator(".route-block")).toHaveCount(2);
});

/* ================= 跨船隔离 ================= */
test("调整一条索路只改对应船", async ({ page, request }) => {
  const ctx = globalThis.__ctx;
  const sidA = await createShip(ctx, "E2E-SHIP-A");
  await createShip(ctx, "E2E-SHIP-B");
  await addNode(ctx, sidA, { id: "M1", type: "桅杆", zone: "主桅" });
  await addNode(ctx, sidA, { id: "T1", type: "系点", zone: "主桅" });

  await openShip(page, "E2E-SHIP-A");
  await submitRouteUI(page, { id: "LA", name: "甲船索", start: "M1", end: "T1", targetZone: "主桅" });
  await expect(page.locator("#routeTable")).toContainText("甲船索");

  // 切到乙船：没有任何节点与索路
  await openShip(page, "E2E-SHIP-B");
  await expect(page.locator("#routeTable")).toContainText("暂无索路");
  await expect(page.locator("#graph")).toContainText("暂无节点");
  const repA = await (await request.get(`/api/ships/${sidA}`)).json();
  expect(repA.report.totalRoutes).toBe(1); // 服务端复核：甲船仍只有自己的 1 条
});

/* ================= 提交失败：路径与状态不动 ================= */
test("提交失败时表单路径保留、页面状态不变", async ({ page }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-FAIL");
  for (const n of [
    { id: "M1", type: "桅杆", zone: "主桅" },
    { id: "B1", type: "滑轮", zone: "主桅" },
    { id: "T1", type: "系点", zone: "主桅" }
  ]) await addNode(ctx, sid, n);
  await addLink(ctx, sid, "M1", "B1");
  await addLink(ctx, sid, "B1", "T1");

  await openShip(page, "E2E-FAIL");
  // 第一次提交成功
  await submitRouteUI(page, { id: "LDUP", name: "原索", start: "M1", end: "T1", via: "B1", targetZone: "主桅" });
  await expect(page.locator("#stateOk")).toContainText("可装配");

  // 重复索号再次提交（不同路径）-> 400
  const resp = await submitRouteUI(page, { id: "LDUP", name: "不该出现的索", start: "T1", end: "M1", via: "B1", targetZone: "后桅" });
  expect(resp.status()).toBe(400);

  // 表单里的路径原样保留
  await expect(page.locator("#routeError")).toContainText("提交失败");
  await expect(page.locator("#routeError")).toContainText("页面数据未改动");
  await expect(page.locator("#routeForm [name=rid]")).toHaveValue("LDUP");
  await expect(page.locator("#routeForm [name=name]")).toHaveValue("不该出现的索");
  await expect(page.locator("#routeStart")).toHaveValue("T1");

  // 页面状态仍是提交前：1 条原索、可装配
  await expect(page.locator("#stateOk")).toContainText("可装配");
  await expect(page.locator("#routeTable")).toContainText("原索");
  await expect(page.locator("#routeTable")).not.toContainText("不该出现的索");
  expect(await page.locator("#routeTable tr").count()).toBe(2); // 表头 + 1 条
});

test("节点表单提交失败也不改动数据", async ({ page }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-FAIL2");
  await addNode(ctx, sid, { id: "B1", type: "滑轮", zone: "主桅" });

  await openShip(page, "E2E-FAIL2");
  await page.fill("#nodeForm [name=id]", "B1");
  await page.selectOption("#nodeType", "滑轮");
  await page.fill("#nodeForm [name=zone]", "主桅");
  await page.click("#nodeForm button[type=submit]");
  await expect(page.locator("#nodeError")).toContainText("已登记");
  await expect(page.locator("#nodeForm [name=id]")).toHaveValue("B1"); // 输入保留
  expect(await page.locator("[data-del-node]").count()).toBe(1); // 仍是原来 1 个
});

/* ================= 重启后数据仍在（另起进程读同一数据文件） ================= */
test("重启后数据仍在", async ({ page }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-PERSIST");
  await addNode(ctx, sid, { id: "M1", type: "桅杆", zone: "主桅" });
  await addNode(ctx, sid, { id: "T1", type: "系点", zone: "主桅" });

  await openShip(page, "E2E-PERSIST");
  await submitRouteUI(page, { id: "LP", name: "持久化索", start: "M1", end: "T1", targetZone: "主桅" });
  await expect(page.locator("#routeTable")).toContainText("持久化索");

  // 数据确实落盘
  const onDisk = JSON.parse(readFileSync(DB_PATH, "utf8"));
  expect(JSON.stringify(onDisk)).toContain("持久化索");

  // 用另一个端口新起一个服务进程（冷启动读同一个数据文件）
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "4401", DB_PATH },
    stdio: "ignore"
  });
  try {
    const restarted = `http://localhost:4401`;
    // 等待新进程就绪
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(restarted + "/api/ships");
        if (r.ok) break;
      } catch {}
      await page.waitForTimeout(250);
    }
    const res = await fetch(`${restarted}/api/ships/${sid}/report`);
    expect(res.ok).toBeTruthy();
    const rep = await res.json();
    expect(rep.report.totalRoutes).toBe(1);
    expect(rep.report.routes[0].name).toBe("持久化索");

    // 浏览器直接打开重启后的实例确认页面数据
    await page.goto(`${restarted}/rig`);
    const val = await page.$eval("#shipSelect", (sel, code) => {
      const o = [...sel.options].find(o => o.textContent.includes(code));
      return o.value;
    }, "E2E-PERSIST");
    await page.selectOption("#shipSelect", val);
    await expect(page.locator("#routeTable")).toContainText("持久化索");
  } finally {
    child.kill("SIGTERM");
  }
});

/* ================= 反例：目标桅区必填（400 不落盘，页面表单必填） ================= */
test("目标桅区为空：API 拒收且不写盘，索路数量不变", async ({ request }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-ZONE-REQ");
  await addNode(ctx, sid, { id: "M1", type: "桅杆", zone: "主桅" });
  await addNode(ctx, sid, { id: "T1", type: "系点", zone: "主桅" });
  await addLink(ctx, sid, "M1", "T1");

  const before = await (await request.get(`/api/ships/${sid}`)).json();
  const res = await request.post(`/api/ships/${sid}/routes`, {
    data: { id: "LZ", name: "空桅区索", start: "M1", end: "T1", via: [], targetZone: "  " }
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("target_zone_required");

  const after = await (await request.get(`/api/ships/${sid}`)).json();
  expect(after.report.totalRoutes).toBe(before.report.totalRoutes);
  expect(after.report.totalRoutes).toBe(0);
  // 落盘文件里也不能出现该索
  expect(readFileSync(DB_PATH, "utf8")).not.toContain("空桅区索");

  // PATCH 清空目标桅区同样被拒
  await ctx.post(`/api/ships/${sid}/routes`, {
    data: { id: "LZ2", name: "有桅区索", start: "M1", end: "T1", via: [], targetZone: "主桅" }
  });
  const patch = await request.patch(`/api/ships/${sid}/routes/LZ2`, { data: { targetZone: "" } });
  expect(patch.status()).toBe(400);
  const view = await (await request.get(`/api/ships/${sid}`)).json();
  expect(view.rig.routes[0].targetZone).toBe("主桅");
});

test("目标桅区为空：真实浏览器中表单必填并提示终点须回该区", async ({ page }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-ZONE-UI");
  await addNode(ctx, sid, { id: "M1", type: "桅杆", zone: "主桅" });
  await addNode(ctx, sid, { id: "T1", type: "系点", zone: "主桅" });
  await addLink(ctx, sid, "M1", "T1");

  await openShip(page, "E2E-ZONE-UI");
  await page.fill("#routeForm [name=rid]", "LUI");
  await page.fill("#routeForm [name=name]", "界面必填索");
  await page.selectOption("#routeStart", "M1");
  await page.selectOption("#routeEnd", "T1");
  // 目标桅区留空：HTML5 required 阻止提交，且无任何请求发出
  const responsePromise = page.waitForResponse(r => r.url().includes("/routes"), { timeout: 1200 }).catch(() => null);
  await page.click("#routeForm button[type=submit]");
  expect(await responsePromise).toBeNull();
  await expect(page.locator("#routeTable")).not.toContainText("界面必填索");
  // 标签注明必填
  await expect(page.locator("#routeForm label", { hasText: "目标桅区" })).toContainText("必填");
});

/* ================= 反例：每一段连接都必须登记（真实浏览器） ================= */
test("索路任何一段连接未登记都阻断：无白名单与缺后段都不可装配", async ({ page, request }) => {
  const ctx = globalThis.__ctx;
  const sid = await createShip(ctx, "E2E-STRICT-LINK");
  for (const n of [
    { id: "M1", type: "桅杆", zone: "主桅" },
    { id: "B1", type: "滑轮", zone: "主桅" },
    { id: "T1", type: "系点", zone: "主桅" }
  ]) await addNode(ctx, sid, n);
  // 只登记首段
  await addLink(ctx, sid, "M1", "B1");

  await openShip(page, "E2E-STRICT-LINK");
  await submitRouteUI(page, { id: "LMISS", name: "缺后段索", start: "M1", end: "T1", via: "B1", targetZone: "主桅" });

  await expect(page.locator("#stateBlock")).toContainText("阻断");
  const issue = page.locator('.issue[data-issue="unlinked"]').first();
  await expect(issue).toBeVisible();
  await expect(issue).toContainText("连接未登记");
  await expect(issue).toContainText("B1 → T1");
  await expect(issue).toContainText("缺后段索");

  // 新增一条完全没有任何连接关系的船，提交索路后同样阻断
  const sid2 = await createShip(ctx, "E2E-STRICT-LINK2");
  await addNode(ctx, sid2, { id: "X1", type: "桅杆", zone: "主桅" });
  await addNode(ctx, sid2, { id: "Y1", type: "系点", zone: "主桅" });
  const r = await request.post(`/api/ships/${sid2}/routes`, {
    data: { id: "R1", name: "无白名单裸索", start: "X1", end: "Y1", via: [], targetZone: "主桅" }
  });
  expect(r.ok()).toBeTruthy();
  const rep = await (await request.get(`/api/ships/${sid2}/report`)).json();
  expect(rep.report.ready).toBe(false);
  expect(rep.report.blocking[0].issues.map(i => i.type)).toContain("unlinked");
});

/* ================= 反例：并发登记不丢记录、无 5xx、响应与落盘一致 ================= */
test("并发登记 30 个节点：全部成功且全部落盘，无服务端错误", async ({ request }) => {
  const sid = await createShip(globalThis.__ctx, "E2E-CONCURRENT");
  const N = 30;
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    request.post(`/api/ships/${sid}/nodes`, {
      data: { id: `P${i.toString().padStart(2, "0")}`, type: "滑轮", zone: "主桅" }
    })
  ));
  const statuses = results.map(r => r.status());
  expect(statuses.filter(s => s >= 500)).toHaveLength(0);
  expect(statuses.filter(s => s === 201)).toHaveLength(N);

  const view = await (await request.get(`/api/ships/${sid}`)).json();
  const ids = view.rig.nodes.map(n => n.id).sort();
  expect(ids).toEqual(Array.from({ length: N }, (_, i) => `P${i.toString().padStart(2, "0")}`));

  // 落盘文件与成功响应一致
  const onDisk = JSON.parse(readFileSync(DB_PATH, "utf8"));
  const ship = onDisk.items.find(x => x.id === sid);
  expect(ship.rig.nodes).toHaveLength(N);
});

test("并发重复登记同一编号：恰有一个成功，落盘恰有一条", async ({ request }) => {
  const sid = await createShip(globalThis.__ctx, "E2E-CONCURRENT-DUP");
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    request.post(`/api/ships/${sid}/nodes`, { data: { id: "DUP", type: "系点", zone: "主桅" } })
  ));
  const statuses = results.map(r => r.status());
  expect(statuses.filter(s => s === 201)).toHaveLength(1);
  expect(statuses.filter(s => s === 400)).toHaveLength(19);
  expect(statuses.filter(s => s >= 500)).toHaveLength(0);

  const view = await (await request.get(`/api/ships/${sid}`)).json();
  expect(view.rig.nodes).toHaveLength(1);
  expect(view.rig.nodes[0].id).toBe("DUP");
});

test("并发混合写入（建船/节点/连接交错）不丢记录", async ({ request }) => {
  // 对同一条船并发写入；节点先全部落盘后再并发登记依赖它们的连接
  const sid = await createShip(globalThis.__ctx, "E2E-CONCURRENT-MIX");
  const nodeWrites = [];
  for (let i = 0; i < 10; i++) {
    nodeWrites.push(request.post(`/api/ships/${sid}/nodes`, { data: { id: `A${i}`, type: "桅杆", zone: "主桅" } }));
    nodeWrites.push(request.post(`/api/ships/${sid}/nodes`, { data: { id: `T${i}`, type: "系点", zone: "主桅" } }));
  }
  const nodeRes = await Promise.all(nodeWrites);
  expect(nodeRes.filter(r => r.status() >= 500)).toHaveLength(0);
  expect(nodeRes.filter(r => r.status() === 201)).toHaveLength(20);

  // 节点已存在，连接与一条索路并发交错写入
  const writes = [];
  for (let i = 0; i < 10; i++) writes.push(request.post(`/api/ships/${sid}/links`, { data: { from: `A${i}`, to: `T${i}` } }));
  writes.push(request.post(`/api/ships/${sid}/routes`, { data: { id: "R0", name: "并发索", start: "A0", end: "T0", via: [], targetZone: "主桅" } }));
  const results = await Promise.all(writes);
  expect(results.filter(r => r.status() >= 500)).toHaveLength(0);
  expect(results.filter(r => r.status() === 201)).toHaveLength(11);

  const view = await (await request.get(`/api/ships/${sid}`)).json();
  expect(view.rig.nodes).toHaveLength(20);
  expect(view.rig.links).toHaveLength(10);
  expect(view.rig.routes).toHaveLength(1);
  for (const l of view.rig.links) {
    expect(view.rig.nodes.some(n => n.id === l.from)).toBeTruthy();
    expect(view.rig.nodes.some(n => n.id === l.to)).toBeTruthy();
  }
});
