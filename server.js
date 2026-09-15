import http from "node:http";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH
  ? (process.env.DB_PATH.startsWith("/") ? process.env.DB_PATH : join(__dirname, process.env.DB_PATH))
  : join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);

/* ---------------- 索路装配校验：规则常量 ---------------- */
const NODE_TYPES = ["桅杆", "滑轮", "系点", "接头"];
const JOINT_TYPES = ["环扣", "卸扣", "索夹"];
const ISSUE_LABELS = {
  dangling: "悬空端点",
  repeated: "重复经过",
  cross_mast: "跨桅错接",
  unlinked: "连接未登记",
  joint_mismatch: "接头不匹配",
  reversed: "起终点倒置",
  wrong_zone: "未回到目标桅区"
};
const ISSUE_ORDER = ["dangling", "repeated", "cross_mast", "unlinked", "joint_mismatch", "reversed", "wrong_zone"];

function sampleRig() {
  return {
    targetZone: "主桅",
    nodes: [
      { id: "M-F", type: "桅杆", zone: "前桅" },
      { id: "M-M", type: "桅杆", zone: "主桅" },
      { id: "M-A", type: "桅杆", zone: "后桅" },
      { id: "B1", type: "滑轮", zone: "主桅" },
      { id: "B2", type: "滑轮", zone: "主桅" },
      { id: "T1", type: "系点", zone: "主桅" },
      { id: "T2", type: "系点", zone: "主桅" },
      { id: "J1", type: "接头", zone: "主桅", jointType: "环扣" }
    ],
    // 允许连接关系白名单：索路的每一段都必须登记在这里
    links: [
      { from: "M-M", to: "B1" },
      { from: "B1", to: "J1" },
      { from: "J1", to: "B2" },
      { from: "B2", to: "T1" },
      { from: "B2", to: "T2" }
    ],
    routes: [
      { id: "L1", name: "主桅升帆索", start: "M-M", end: "T1", via: ["B1", "J1", "B2"], targetZone: "主桅" }
    ]
  };
}

const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": [],
      ...(existsSync(dbPath) ? {} : { rig: sampleRig() })
    }
  ]
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 迁移：为旧数据中的船补齐空索路结构
  let migrated = false;
  for (const item of db.items || []) {
    if (!item.rig) { item.rig = sampleRig(); migrated = true; }
  }
  if (migrated) await saveDb(db);
  return db;
}
async function saveDb(db) {
  // 测试故障注入：命中一次保存失败（仅在 ENABLE_FAULTS=1 时可被远端设置）
  if (faultFailSaves > 0) {
    faultFailSaves -= 1;
    await rm(dbPath + ".tmp", { force: true }).catch(() => {});
    throw Object.assign(new Error("injected_disk_write_failure"), { code: "EFAULT" });
  }
  const tmp = dbPath + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbPath);
  } catch (error) {
    // 落盘失败不能在磁盘上留下半成品临时文件
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/* ---------------- 并发写入 + 事务性提交 ----------------
   每个请求以前都各自 loadDb()/saveDb()，并发时会互相覆盖（后写赢，丢记录），
   还会争用同一个 .tmp 文件导致服务端错误。现在：
   - db 只加载一次，所有请求读取同一份“已提交”内存；
   - 一切变更经 writeChain 串行执行；
   - 变更在已提交数据的深克隆上进行，saveDb 成功后才把克隆发布为新的已提交内存。
     因此保存失败时：内存维持提交前状态（后续读取看不到未落盘数据，重启也一致），
     成功响应一定对应已经落盘的数据；校验抛 HttpError 时同样不写盘。 */
// 测试用故障注入：仅当 ENABLE_FAULTS=1 时可用，POST /api/test/faults {failSaves:n}
let faultFailSaves = 0;
class HttpError extends Error {
  constructor(statusCode, code, detail) {
    super(detail || code);
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail || code;
  }
}
let dbPromise = null;
const dbHolder = { current: null };
async function getDb() {
  dbPromise ||= loadDb();
  // 只在首次用磁盘数据填充；之后以 withWrite 发布的已提交克隆为准
  if (!dbHolder.current) dbHolder.current = await dbPromise;
  return dbHolder.current;
}
let writeChain = Promise.resolve();
function withWrite(mutator) {
  const run = writeChain.then(async () => {
    const committed = await getDb();
    // 在已提交数据的隔离克隆上做变更，失败可整体丢弃
    const draft = structuredClone(committed);
    const result = await mutator(draft);
    await saveDb(draft); // 落盘成功才提交
    dbHolder.current = draft;
    return result;
  });
  // 一次失败不能中断后续排队的写操作
  writeChain = run.then(() => {}, () => {});
  return run;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId(prefix) { return prefix + "-" + Date.now().toString(36) + Math.floor(process.hrtime()[1] % 1000); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

/* ---------------- 索路装配校验：核心逻辑 ---------------- */
function indexNodes(nodes) {
  const byId = new Map();
  for (const n of nodes || []) byId.set(n.id, n);
  return byId;
}
function indexLinks(links) {
  // from -> Set<to>；若节点出现在链接表中，则以白名单为准
  const out = new Map();
  for (const l of links || []) {
    if (!out.has(l.from)) out.set(l.from, new Set());
    out.get(l.from).add(l.to);
  }
  return out;
}
function linkAllowed(linkMap, fromId, toId) {
  // 严格白名单：from 未登记出向连接或 to 不在其出向集合中，都判为缺失
  return linkMap.get(fromId)?.has(toId) === true;
}

// 校验一条索路，返回问题数组：{type, position, detail}
function validateRoute(route, byId, linkMap) {
  const issues = [];
  const seq = [route.start, ...(route.via || []), route.end];
  const at = i => (i === 0 ? "起点" : i === seq.length - 1 ? "终点" : `途经${i}`);
  const push = (type, position, detail) => issues.push({ type, position, detail });

  // 1. 悬空端点（含经过节点）：编号未登记
  seq.forEach((id, i) => {
    if (!id || !byId.has(id)) push("dangling", at(i), `节点「${id || "空"}」未在本船登记`);
  });
  const known = seq.filter(id => id && byId.has(id));

  // 2. 重复经过
  const seen = new Map();
  seq.forEach((id, i) => {
    if (!id || !byId.has(id)) return;
    if (seen.has(id)) push("repeated", at(i), `节点「${id}」重复经过（首次出现于${seen.get(id)}）`);
    else seen.set(id, at(i));
  });

  const node = id => byId.get(id);

  // 3. 跨桅错接：相邻节点属于不同桅区即视为错接
  for (let i = 1; i < seq.length; i++) {
    const a = node(seq[i - 1]), b = node(seq[i]);
    if (!a || !b) continue;
    if (a.zone !== b.zone) {
      push("cross_mast", at(i), `「${a.id}(${a.zone})」与「${b.id}(${b.zone})」分属不同桅区`);
    }
  }

  // 4. 连接与接头：
  //    a) 每一段相邻连接都必须在登记的允许连接关系中（缺出向登记或缺某段同样阻断）；
  //       任一端是接头时归为“接头不匹配”，否则归为“连接未登记”
  //    b) 相邻两个接头型号必须一致（每个接头只与前一个接头比较，避免重复报告）
  for (let i = 1; i < seq.length; i++) {
    const a = node(seq[i - 1]), b = node(seq[i]);
    if (!a || !b) continue;
    if (b.type === "接头" && a.type === "接头" && a.jointType && b.jointType && a.jointType !== b.jointType) {
      push("joint_mismatch", at(i), `相邻接头「${a.id}(${a.jointType})」与「${b.id}(${b.jointType})」型号不匹配`);
    }
    if (!linkAllowed(linkMap, a.id, b.id)) {
      const isJoint = a.type === "接头" || b.type === "接头";
      if (isJoint) {
        const j = a.type === "接头" ? a : b;
        push("joint_mismatch", at(i), `接头「${j.id}」侧的连接「${a.id} → ${b.id}」未登记在允许连接关系中`);
      } else {
        push("unlinked", at(i), `连接段「${a.id} → ${b.id}」未登记允许连接关系`);
      }
    }
  }

  // 4/5. 起终点倒置：起终点必须是系点或桅杆；起点应为高位节点(桅杆/滑轮)，终点应为系点
  const s = node(route.start), e = node(route.end);
  if (s && e) {
    if (s.type === "系点" && (e.type === "桅杆" || e.type === "滑轮")) {
      push("reversed", "起点", `起点为系点「${s.id}」而终点为${e.type}「${e.id}」，受力方向倒置`);
    }
    if (s.type === "系点" && e.type === "系点") {
      push("reversed", "起点", "起终点均为系点，缺少施力桅端，疑似倒置");
    }
  }

  // 6. 未回到目标桅区：目标桅区必填，且终点必须回到该区
  if (e) {
    if (!route.targetZone) {
      push("wrong_zone", "目标桅区", "索路未填写目标桅区");
    } else if (e.zone !== route.targetZone) {
      push("wrong_zone", "终点", `终点「${e.id}」位于${e.zone}桅区，未回到目标桅区${route.targetZone}`);
    }
  }

  // 去重（同一位置同一描述），按出现顺序
  const uniq = new Map();
  for (const iss of issues) {
    const key = iss.type + "|" + iss.position + "|" + iss.detail;
    if (!uniq.has(key)) uniq.set(key, iss);
  }
  return [...uniq.values()];
}

function validateRig(rig) {
  const byId = indexNodes(rig?.nodes);
  const linkMap = indexLinks(rig?.links);
  const routesReport = (rig?.routes || []).map(route => {
    const issues = validateRoute(route, byId, linkMap);
    return { id: route.id, name: route.name, start: route.start, end: route.end, via: route.via || [], targetZone: route.targetZone, issues, ok: issues.length === 0 };
  });
  const blocking = routesReport.filter(r => !r.ok);
  return {
    routes: routesReport,
    blocking,
    issueSummary: ISSUE_ORDER.map(type => ({
      type,
      label: ISSUE_LABELS[type],
      count: routesReport.reduce((n, r) => n + r.issues.filter(i => i.type === type).length, 0)
    })).filter(x => x.count > 0),
    ready: blocking.length === 0 && routesReport.length > 0,
    totalRoutes: routesReport.length
  };
}

/* ---------------- 页面 ---------------- */
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    a.navbtn { text-decoration:none; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联</div></div><div style="display:flex;gap:10px"><a class="navbtn" href="/rig">索路装配校验台</a><button id="reload">刷新</button></div></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

function rigPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>索路装配校验台 · 古船模型帆索校准</title>
  <style>
    :root { --bg:#ecefe8; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --ok:#3d7a4f; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
    h1 { margin:0; font-size:22px; } h2,h3 { margin:0 0 10px; }
    .meta { color:var(--muted); font-size:13px; }
    main { padding:20px 26px; display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); gap:18px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button.mini { padding:4px 8px; font-size:12px; }
    a.navbtn { text-decoration:none; border-radius:6px; background:#69736a; color:#fff; padding:8px 12px; font-weight:700; font-size:13px; display:inline-block; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:12px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .toolbar select { width:auto; min-width:150px; }
    .badge { display:inline-block; border-radius:999px; padding:3px 10px; font-size:13px; font-weight:700; }
    .badge.ok { background:#e2f0e4; color:var(--ok); border:1px solid #b9d6bd; }
    .badge.block { background:#f7e4de; color:var(--warn); border:1px solid #e3bcb0; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { text-align:left; border-bottom:1px solid var(--line); padding:7px 8px; vertical-align:top; }
    th { color:var(--muted); font-weight:600; }
    .issue { background:#faf1ee; border:1px solid #e3bcb0; border-radius:6px; padding:7px 9px; margin:6px 0; }
    .issue b { color:var(--warn); }
    .issue .pos { color:var(--muted); }
    .chip { display:inline-block; background:#eef1ea; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; margin:2px 4px 2px 0; }
    .chip.filter { cursor:pointer; user-select:none; }
    .chip.filter.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    svg { width:100%; height:auto; background:#fbfcfa; border:1px solid var(--line); border-radius:8px; }
    .node-label { font-size:11px; fill:var(--ink); }
    .err-text { color:var(--warn); font-size:12px; min-height:16px; margin-top:6px; }
    .ok-text { color:var(--ok); font-size:13px; }
    @media (max-width:980px){ main{grid-template-columns:1fr;padding:14px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>索路装配校验台</h1><div class="meta">登记桅杆 / 滑轮 / 系点 / 接头，校验每条帆索的有向索路</div></div>
    <div class="toolbar">
      <label style="margin:0">船</label>
      <select id="shipSelect" aria-label="选择船"></select>
      <a class="navbtn" href="/">返回校准页</a>
    </div>
  </header>
  <main>
    <section>
      <div class="panel">
        <div class="toolbar" style="justify-content:space-between">
          <h2 style="margin:0">索路图</h2>
          <span id="readyBadge"></span>
        </div>
        <div id="graph"></div>
        <div class="meta" style="margin-top:8px">灰色虚线为已登记的允许连接关系；索路的<b>每一段</b>都必须登记。彩色有向箭头为索路，<b style="color:var(--warn)">红色</b>表示该索路有阻断问题。</div>
      </div>

      <div class="panel">
        <h2>阻断清单</h2>
        <div class="toolbar" style="margin-bottom:8px">
          <span class="meta">按问题筛选：</span>
          <span class="chip filter active" data-type="">全部</span>
          <span id="filterChips"></span>
        </div>
        <div id="blockList"></div>
      </div>
    </section>

    <section>
      <div class="panel">
        <h2>节点登记 <span class="meta">（桅杆 · 滑轮 · 系点 · 接头）</span></h2>
        <form id="nodeForm">
          <div class="row">
            <div><label>编号</label><input name="id" required placeholder="如 B3"></div>
            <div><label>类型</label><select name="type" id="nodeType"></select></div>
          </div>
          <div class="row">
            <div><label>桅区</label><input name="zone" required placeholder="如 主桅"></div>
            <div id="jointTypeWrap" style="display:none"><label>接头型号</label><select name="jointType" id="jointType"></select></div>
          </div>
          <div style="margin-top:10px"><button type="submit">登记节点</button></div>
          <div class="err-text" id="nodeError"></div>
        </form>
        <form id="linkForm" style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px">
          <h3>允许连接关系 <span class="meta">（必填：索路的每一段都要登记）</span></h3>
          <div class="row">
            <div><label>从</label><select name="from" id="linkFrom"></select></div>
            <div><label>到</label><select name="to" id="linkTo"></select></div>
          </div>
          <div style="margin-top:8px"><button type="submit" class="secondary">登记连接</button></div>
          <div class="err-text" id="linkError"></div>
          <div id="linkList" class="meta" style="margin-top:6px"></div>
        </form>
        <div id="nodeTable" style="margin-top:12px"></div>
      </div>

      <div class="panel">
        <h2>帆索索路 <span class="meta">（有向：起点 → 经过 → 终点）</span></h2>
        <form id="routeForm">
          <div class="row">
            <div><label>索号</label><input name="rid" required placeholder="如 L2"></div>
            <div><label>索名/索位</label><input name="name" required placeholder="如 主桅侧支索"></div>
          </div>
          <div class="row">
            <div><label>起点</label><select name="start" id="routeStart"></select></div>
            <div><label>终点</label><select name="end" id="routeEnd"></select></div>
          </div>
          <label>经过节点（按顺序，逗号或空格分隔）</label>
          <input name="via" placeholder="如 B1, J1, B2">
          <div class="row">
            <div><label>目标桅区（必填）</label><input name="targetZone" required placeholder="主桅，终点必须回到该区"></div>
            <div style="display:flex;align-items:end"><button type="submit" style="width:100%">提交索路</button></div>
          </div>
          <div class="err-text" id="routeError"></div>
        </form>
        <div id="routeTable" style="margin-top:12px"></div>
      </div>
    </section>
  </main>

  <script>
    const NODE_TYPES = ["桅杆","滑轮","系点","接头"];
    const JOINT_TYPES = ["环扣","卸扣","索夹"];
    const ISSUE_LABELS = { dangling:"悬空端点", repeated:"重复经过", cross_mast:"跨桅错接", unlinked:"连接未登记", joint_mismatch:"接头不匹配", reversed:"起终点倒置", wrong_zone:"未回到目标桅区" };
    const ISSUE_ORDER = ["dangling","repeated","cross_mast","unlinked","joint_mismatch","reversed","wrong_zone"];
    const ZONE_COLORS = { "前桅":"#4b6cb7", "主桅":"#526f43", "后桅":"#8a6d3b" };

    const $ = s => document.querySelector(s);
    const shipSelect = $("#shipSelect");
    let ships = [], ship = null, report = null, filterType = "";

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || "请求失败"), { status: res.status, data });
      return data;
    }
    const shipBase = () => "/api/ships/" + encodeURIComponent(shipSelect.value);

    function initStaticForms() {
      $("#nodeType").innerHTML = NODE_TYPES.map(t => "<option>"+t+"</option>").join("");
      $("#jointType").innerHTML = JOINT_TYPES.map(t => "<option>"+t+"</option>").join("");
      $("#nodeType").onchange = e => { $("#jointTypeWrap").style.display = e.target.value === "接头" ? "" : "none"; };
    }

    async function loadShips() {
      ships = await api("/api/ships");
      const prev = shipSelect.value;
      shipSelect.innerHTML = ships.map(s => "<option value='"+s.id+"'>"+s.code+" · "+s.shipType+"</option>").join("");
      if (prev && ships.some(s => s.id === prev)) shipSelect.value = prev;
      await loadShip();
    }
    async function loadShip() {
      ship = await api(shipBase());
      report = ship.report;
      render();
    }

    function nodeSelects() {
      const opts = ship.rig.nodes.map(n => "<option value='"+n.id+"'>"+n.id+" · "+n.type+" · "+n.zone+"</option>").join("");
      $("#routeStart").innerHTML = opts; $("#routeEnd").innerHTML = opts;
      $("#linkFrom").innerHTML = opts; $("#linkTo").innerHTML = opts;
      $("#linkList").textContent = (ship.rig.links || []).length
        ? "已登记：" + ship.rig.links.map(l => l.from+"→"+l.to).join("，")
        : "";
    }

    function render() {
      nodeSelects();
      // 可装配状态
      $("#readyBadge").innerHTML = report.ready
        ? "<span class='badge ok' id='stateOk'>可装配 · "+report.totalRoutes+" 条索路全部通过</span>"
        : "<span class='badge block' id='stateBlock'>阻断 · "+report.blocking.length+" / "+report.totalRoutes+" 条索路不合格</span>";

      // 筛选 chips
      const present = new Set();
      report.blocking.forEach(r => r.issues.forEach(i => present.add(i.type)));
      $("#filterChips").innerHTML = ISSUE_ORDER.filter(t => present.has(t))
        .map(t => "<span class='chip filter' data-type='"+t+"'>"+ISSUE_LABELS[t]+"</span>").join("");
      document.querySelectorAll(".chip.filter").forEach(c => {
        c.classList.toggle("active", c.dataset.type === filterType);
        c.onclick = () => { filterType = c.dataset.type; render(); };
      });

      renderGraph();
      renderBlockList();
      renderNodeTable();
      renderRouteTable();
    }

    function layoutNodes(nodes) {
      // 按桅区分组列布局
      const zones = [...new Set(nodes.map(n => n.zone))];
      const pos = {}, colW = 190, rowH = 96;
      const perZone = {};
      zones.forEach((z, zi) => {
        const inZone = nodes.filter(n => n.zone === z);
        perZone[z] = inZone.length;
        inZone.forEach((n, ni) => { pos[n.id] = { x: 60 + zi * colW, y: 60 + ni * rowH, n }; });
      });
      return { pos, width: Math.max(260, zones.length * colW + 40), height: Math.max(220, Math.max(0, ...Object.values(perZone)) * rowH + 80) };
    }

    function renderGraph() {
      const nodes = ship.rig.nodes;
      if (!nodes.length) { $("#graph").innerHTML = "<div class='meta'>暂无节点，请先登记。</div>"; return; }
      const { pos, width, height } = layoutNodes(nodes);
      const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
      let edges = "";
      // 允许连接关系（灰线）
      (ship.rig.links || []).forEach(l => {
        const a = pos[l.from], b = pos[l.to];
        if (!a || !b) return;
        edges += "<line x1='"+a.x+"' y1='"+a.y+"' x2='"+b.x+"' y2='"+b.y+"' stroke='#cdd5c8' stroke-width='1.5' stroke-dasharray='4 3'/>";
      });
      // 索路（彩色有向折线）
      const routeById = Object.fromEntries(report.routes.map(r => [r.id, r]));
      report.routes.forEach((r, ri) => {
        const seq = [r.start, ...r.via, r.end];
        const color = r.ok ? (ZONE_COLORS[byId[r.start]?.zone] || "#3d7a4f") : "#b23b27";
        for (let i = 1; i < seq.length; i++) {
          const a = pos[seq[i-1]], b = pos[seq[i]];
          if (!a || !b) continue;
          const ox = (ri % 3 - 1) * 6, oy = (ri % 3 - 1) * 6;
          edges += "<line x1='"+(a.x+ox)+"' y1='"+(a.y+oy)+"' x2='"+(b.x- (b.x>a.x?8:b.x<a.x?-8:0))+"' y2='"+(b.y+oy-(b.y>a.y?8:b.y<a.y?-8:0))+"' stroke='"+color+"' stroke-width='2.2' marker-end='url(#arrow"+(r.ok?"ok":"bad")+")' />";
        }
      });
      let circles = "";
      Object.values(pos).forEach(({x,y,n}) => {
        const fill = { "桅杆":"#e8ece2", "滑轮":"#e3ecf6", "系点":"#f3ece0", "接头":"#f6e4e4" }[n.type] || "#fff";
        circles += "<circle cx='"+x+"' cy='"+y+"' r='17' fill='"+fill+"' stroke='#5a6358' stroke-width='1.4'/>"
          + "<text class='node-label' x='"+x+"' y='"+(y+34)+"' text-anchor='middle'>"+n.id+"·"+n.type+(n.jointType?"·"+n.jointType:"")+"</text>";
      });
      $("#graph").innerHTML =
        "<svg viewBox='0 0 "+width+" "+height+"' role='img' aria-label='索路图'>"
        + "<defs><marker id='arrowok' markerWidth='9' markerHeight='9' refX='8' refY='3' orient='auto'><path d='M0,0 L8,3 L0,6 Z' fill='#3d7a4f'/></marker>"
        + "<marker id='arrowbad' markerWidth='9' markerHeight='9' refX='8' refY='3' orient='auto'><path d='M0,0 L8,3 L0,6 Z' fill='#b23b27'/></marker></defs>"
        + edges + circles + "</svg>";
    }

    function renderBlockList() {
      const bad = report.blocking.filter(r => !filterType || r.issues.some(i => i.type === filterType));
      if (!bad.length) {
        $("#blockList").innerHTML = report.ready
          ? "<div class='ok-text' id='allClear'>✔ 全部索路通过校验，可装配。</div>"
          : "<div class='meta'>当前筛选下没有阻断项。</div>";
        return;
      }
      $("#blockList").innerHTML = bad.map(r => {
        const issues = r.issues.filter(i => !filterType || i.type === filterType)
          .map(i => "<div class='issue' data-issue='"+i.type+"' data-position='"+(r.name||r.id)+"'><b>"+ISSUE_LABELS[i.type]+"</b> <span class='pos'>［索位："+(r.name||r.id)+" · "+i.position+"］</span><div>"+i.detail+"</div></div>").join("");
        return "<div class='route-block' data-route='"+r.id+"' style='margin-bottom:12px'><h3>"+r.id+" · "+(r.name||"")+"</h3>"
          + "<div class='meta'>"+r.start+" → "+(r.via.length?r.via.join(" → ")+" → ":"")+r.end+" · 目标桅区 "+(r.targetZone||"—")+"</div>"+issues+"</div>";
      }).join("");
    }

    function renderNodeTable() {
      if (!ship.rig.nodes.length) { $("#nodeTable").innerHTML = ""; return; }
      $("#nodeTable").innerHTML = "<table><thead><tr><th>编号</th><th>类型</th><th>桅区</th><th>型号</th><th></th></tr></thead><tbody>"
        + ship.rig.nodes.map(n => "<tr><td>"+n.id+"</td><td>"+n.type+"</td><td>"+n.zone+"</td><td>"+(n.jointType||"")+"</td><td><button class='mini danger' data-del-node='"+n.id+"'>删除</button></td></tr>").join("")
        + "</tbody></table>";
      document.querySelectorAll("[data-del-node]").forEach(b => b.onclick = async () => {
        try { await api(shipBase()+"/nodes/"+encodeURIComponent(b.dataset.delNode), { method:"DELETE" }); await loadShip(); }
        catch (err) { alert(err.message); }
      });
    }

    function renderRouteTable() {
      if (!report.routes.length) { $("#routeTable").innerHTML = "<div class='meta'>暂无索路。</div>"; return; }
      $("#routeTable").innerHTML = "<table><thead><tr><th>索号/索位</th><th>路径</th><th>结果</th><th></th></tr></thead><tbody>"
        + report.routes.map(r => "<tr><td>"+r.id+"<br><span class='meta'>"+(r.name||"")+"</span></td>"
          + "<td>"+r.start+" → "+(r.via.length?r.via.join(" → ")+" → ":"")+r.end+"<br><span class='meta'>目标 "+(r.targetZone||"—")+"</span></td>"
          + "<td>"+(r.ok ? "<span class='badge ok'>通过</span>" : "<span class='badge block'>"+r.issues.length+" 项</span>")+"</td>"
          + "<td><button class='mini danger' data-del-route='"+r.id+"'>删除</button></td></tr>").join("")
        + "</tbody></table>";
      document.querySelectorAll("[data-del-route]").forEach(b => b.onclick = async () => {
        try { await api(shipBase()+"/routes/"+encodeURIComponent(b.dataset.delRoute), { method:"DELETE" }); await loadShip(); }
        catch (err) { alert(err.message); }
      });
    }

    // 提交：失败时保留表单（路径与状态不动），仅显示错误
    async function submitKeepForm(form, url, payload, errEl, after) {
      errEl.textContent = "";
      try {
        await api(url, { method:"POST", body: JSON.stringify(payload) });
        form.reset();
        $("#jointTypeWrap").style.display = "none";
        await after();
      } catch (err) {
        errEl.textContent = "提交失败：" + (err.data && err.data.detail ? err.data.detail : err.message) + "（页面数据未改动）";
      }
    }

    $("#nodeForm").onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const payload = { id: f.get("id").trim(), type: f.get("type"), zone: f.get("zone").trim() };
      if (payload.type === "接头") payload.jointType = f.get("jointType");
      submitKeepForm(e.target, shipBase()+"/nodes", payload, $("#nodeError"), loadShip);
    };

    $("#routeForm").onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const via = (f.get("via") || "").split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      const payload = { id: f.get("rid").trim(), name: f.get("name").trim(), start: f.get("start"), end: f.get("end"), via, targetZone: f.get("targetZone").trim() };
      submitKeepForm(e.target, shipBase()+"/routes", payload, $("#routeError"), loadShip);
    };

    $("#linkForm").onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (f.get("from") === f.get("to")) { $("#linkError").textContent = "提交失败：连接两端不能是同一节点（页面数据未改动）"; return; }
      submitKeepForm(e.target, shipBase()+"/links", { from: f.get("from"), to: f.get("to") }, $("#linkError"), loadShip);
    };

    shipSelect.onchange = () => { filterType = ""; loadShip(); };
    initStaticForms();
    loadShips();
  </script>
</body>
</html>`;
}

/* ---------------- 路由与校验辅助 ---------------- */
function findShip(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function ensureRig(ship) {
  if (!ship.rig) ship.rig = { nodes: [], links: [], routes: [] };
  ship.rig.nodes ||= [];
  ship.rig.links ||= [];
  ship.rig.routes ||= [];
  return ship.rig;
}
function shipView(ship) {
  const rig = ensureRig(ship);
  return {
    id: ship.id || ship.code,
    code: ship.code,
    shipType: ship.shipType,
    rig,
    report: validateRig(rig)
  };
}
function err400(res, code, detail) { return send(res, 400, { error: code, detail }); }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    /* 仅测试环境（ENABLE_FAULTS=1）：模拟磁盘写入失败 */
    if (url.pathname === "/api/test/faults") {
      if (process.env.ENABLE_FAULTS !== "1") return send(res, 404, { error: "not_found" });
      if (req.method === "POST") {
        const input = await body(req);
        faultFailSaves = Math.max(0, Number(input.failSaves) || 0);
        return send(res, 200, { failSaves: faultFailSaves });
      }
      if (req.method === "GET") return send(res, 200, { failSaves: faultFailSaves });
    }

    const db = await getDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/rig") return html(res, rigPage());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const saved = await withWrite(d => {
        const item = { id: newId("MR"), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
        item.tasks = [];
        item.rig = { targetZone: "", nodes: [], links: [], routes: [] };
        d.items.unshift(item);
        return item;
      });
      return send(res, 201, saved);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const input = await body(req);
      const saved = await withWrite(d => {
        const item = d.items.find(x => x.id === patch[1] || x.code === patch[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        Object.assign(item, input);
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        return item;
      });
      return send(res, 200, saved);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      const saved = await withWrite(d => {
        const item = d.items.find(x => x.id === log[1] || x.code === log[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        return item;
      });
      return send(res, 201, saved);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const input = await body(req);
      const saved = await withWrite(d => {
        const item = d.items.find(x => x.id === action[1] || x.code === action[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        item.logs ||= [];
        item.tasks ||= [];
        item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
        item.status = "校准中";
        item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
        return item;
      });
      return send(res, 201, saved);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    /* ---------- 索路装配校验 API ---------- */
    if (req.method === "GET" && url.pathname === "/api/ships") {
      return send(res, 200, db.items.map(x => ({ id: x.id || x.code, code: x.code, shipType: x.shipType, ready: validateRig(ensureRig(x)).ready })));
    }
    const shipMatch = url.pathname.match(/^\/api\/ships\/([^/]+)(?:\/(nodes|routes|report|links)(?:\/(.+))?)?$/);
    if (shipMatch) {
      const shipKey = decodeURIComponent(shipMatch[1]);
      const resource = shipMatch[2];
      const locate = d => {
        const ship = findShip(d, shipKey);
        if (!ship) throw new HttpError(404, "ship_not_found");
        return { ship, rig: ensureRig(ship) };
      };

      if (req.method === "GET" && (!resource || resource === "report")) {
        const { ship, rig } = locate(db);
        return send(res, 200, resource === "report" ? { code: ship.code, report: validateRig(rig) } : shipView(ship));
      }

      if (resource === "nodes" && req.method === "POST") {
        const input = await body(req);
        const saved = await withWrite(d => {
          const { rig, ship } = locate(d);
          const id = String(input.id || "").trim();
          if (!id) throw new HttpError(400, "node_id_required", "节点编号不能为空");
          if (rig.nodes.some(n => n.id === id)) throw new HttpError(400, "node_exists", `编号「${id}」已登记`);
          if (!NODE_TYPES.includes(input.type)) throw new HttpError(400, "bad_node_type", `节点类型必须是：${NODE_TYPES.join(" / ")}`);
          const zone = String(input.zone || "").trim();
          if (!zone) throw new HttpError(400, "zone_required", "桅区不能为空");
          const node = { id, type: input.type, zone };
          if (input.type === "接头") {
            if (!JOINT_TYPES.includes(input.jointType)) throw new HttpError(400, "bad_joint_type", `接头型号必须是：${JOINT_TYPES.join(" / ")}`);
            node.jointType = input.jointType;
          }
          rig.nodes.push(node);
          return ship;
        });
        return send(res, 201, shipView(saved));
      }

      const nodeId = shipMatch[3] && resource === "nodes" ? decodeURIComponent(shipMatch[3]) : null;
      if (nodeId && req.method === "DELETE") {
        const saved = await withWrite(d => {
          const { rig, ship } = locate(d);
          const idx = rig.nodes.findIndex(n => n.id === nodeId);
          if (idx < 0) throw new HttpError(404, "node_not_found");
          rig.nodes.splice(idx, 1);
          rig.links = rig.links.filter(l => l.from !== nodeId && l.to !== nodeId);
          rig.routes.forEach(r => {
            if (r.start === nodeId) r.start = "";
            if (r.end === nodeId) r.end = "";
            r.via = (r.via || []).filter(v => v !== nodeId);
          });
          return ship;
        });
        return send(res, 200, shipView(saved));
      }

      if (resource === "links" && req.method === "POST") {
        const input = await body(req);
        const saved = await withWrite(d => {
          const { rig, ship } = locate(d);
          if (!rig.nodes.some(n => n.id === input.from) || !rig.nodes.some(n => n.id === input.to)) {
            throw new HttpError(400, "link_node_unknown", "允许连接的两端节点必须先登记");
          }
          if (input.from === input.to) throw new HttpError(400, "link_self", "连接两端不能是同一节点");
          if (!rig.links.some(l => l.from === input.from && l.to === input.to)) rig.links.push({ from: input.from, to: input.to });
          return ship;
        });
        return send(res, 201, shipView(saved));
      }

      if (resource === "routes" && req.method === "POST") {
        const input = await body(req);
        const id = String(input.id || "").trim();
        const name = String(input.name || "").trim();
        const targetZone = String(input.targetZone || "").trim();
        if (!id) return err400(res, "route_id_required", "索号不能为空");
        if (!name) return err400(res, "route_name_required", "索名/索位不能为空");
        if (!input.start || !input.end) return err400(res, "endpoint_required", "起点和终点都必须填写");
        if (!targetZone) return err400(res, "target_zone_required", "目标桅区必填，且终点必须回到该区");
        const via = Array.isArray(input.via) ? input.via.map(String) : [];
        const saved = await withWrite(d => {
          const { rig, ship } = locate(d);
          if (rig.routes.some(r => r.id === id)) throw new HttpError(400, "route_exists", `索号「${id}」已存在`);
          // 索路即使存在校验问题（跨桅、未登记连接、未回目标桅区等）也允许登记，问题由报告标出
          rig.routes.push({ id, name, start: input.start, end: input.end, via, targetZone });
          return ship;
        });
        return send(res, 201, shipView(saved));
      }

      const routeId = shipMatch[3] && resource === "routes" ? decodeURIComponent(shipMatch[3]) : null;
      if (routeId && req.method === "PATCH") {
        const input = await body(req);
        const saved = await withWrite(d => {
          const { rig, ship } = locate(d);
          const route = rig.routes.find(r => r.id === routeId);
          if (!route) throw new HttpError(404, "route_not_found");
          const targetZone = input.targetZone !== undefined ? String(input.targetZone || "").trim() : route.targetZone;
          if (!targetZone) throw new HttpError(400, "target_zone_required", "目标桅区必填，且终点必须回到该区");
          Object.assign(route, {
            name: input.name ?? route.name,
            start: input.start ?? route.start,
            end: input.end ?? route.end,
            via: Array.isArray(input.via) ? input.via : route.via,
            targetZone
          });
          return ship;
        });
        return send(res, 200, shipView(saved));
      }
      if (routeId && req.method === "DELETE") {
        const saved = await withWrite(d => {
          const { rig, ship } = locate(d);
          const idx = rig.routes.findIndex(r => r.id === routeId);
          if (idx < 0) throw new HttpError(404, "route_not_found");
          rig.routes.splice(idx, 1);
          return ship;
        });
        return send(res, 200, shipView(saved));
      }
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error.statusCode || 500;
    send(res, status, { error: error.code || error.message, detail: error.detail || error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));

export { validateRoute, validateRig, ISSUE_LABELS };
