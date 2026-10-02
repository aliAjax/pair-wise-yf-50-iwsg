/**
 * 续作批次端到端逻辑验证（utils 层，使用相对路径，不依赖 Nuxt 别名）。
 * 运行：node --import tsx tests/sync-flow.mjs
 */

const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k)
};
let counter = 0;
try {
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => `u${(counter++).toString(16)}-0000-0000-0000-000000000000` },
    configurable: true
  });
} catch {
  /* Node 自带 crypto.randomUUID，忽略 */
}

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

const { SimulatedStationServer } = await import("../utils/sync.ts");
const { mergeRemoteState } = await import("../utils/merge.ts");
const { buildSeedHouseholds, buildSeedTasks, fieldBaseline } = await import("../utils/seed.ts");

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function freshServerState() {
  return { clock: 0, households: clone(buildSeedHouseholds().filter((h) => h.ack)), tasks: clone(buildSeedTasks()), ledger: [] };
}

console.log("\n[1] 批次幂等：重发只拿第一次结果，不产生副本");
{
  const server = new SimulatedStationServer(freshServerState());
  const h = server.state.households.find((x) => x.id === "h2");
  const item = {
    clientItemId: "q1", seq: 1, deviceId: "PAD-TEST", kind: "householdUpsert", householdId: "h2", clientId: "c1",
    fields: { note: "第一次发送的值" },
    bases: { note: JSON.stringify(h.note) }
  };
  const r1 = server.submitBatch(7, [item]);
  const firstNote = server.state.households.find((x) => x.id === "h2").note;
  const replay = server.submitBatch(7, [{ ...item, fields: { note: "重放时被篡改的值" } }]);
  const replayNote = server.state.households.find((x) => x.id === "h2").note;

  assert(r1.duplicate === false, "首次发送 duplicate=false");
  assert(r1.results[0].ok === true, "首次发送成功收下");
  assert(firstNote === "第一次发送的值", "首次值已落对端");
  assert(replay.duplicate === true, "重发 duplicate=true");
  assert(replay.results[0].duplicate === true, "重发笔标记为回放");
  assert(replayNote === "第一次发送的值", "重放不覆盖第一次结果");
  assert(server.state.households.filter((x) => x.id === "h2").length === 1, "没有产生副本");
}

console.log("\n[2] 字段级验收：同事改过的字段被拒，其余字段照常收下");
{
  const server = new SimulatedStationServer(freshServerState());
  server.state.households.find((x) => x.id === "h1").address = "同事刚改的地址";
  const base = fieldBaseline(buildSeedHouseholds().find((x) => x.id === "h1"));
  const r = server.submitBatch(1, [
    {
      clientItemId: "q2", seq: 1, deviceId: "PAD", kind: "householdUpsert", householdId: "h1",
      fields: { address: "我这边改的地址", note: "我这边补的说明" },
      bases: { address: base.address, note: base.note }
    }
  ]);
  const got = r.results[0];
  assert(got.ok === false && got.code === "conflict", "整笔带冲突返回");
  assert(JSON.stringify(got.acceptedFields) === JSON.stringify(["note"]), "note 被收下");
  assert(got.rejected.length === 1 && got.rejected[0].field === "address", "address 被拒绝并带回对端现值");
  assert(server.state.households.find((x) => x.id === "h1").address === "同事刚改的地址", "对端同事的改动未被覆盖");
  assert(server.state.households.find((x) => x.id === "h1").note === "我这边补的说明", "不冲突字段正常合并");
}

console.log("\n[3] 失败后续作：error 笔不收下不缓存，下一批只重试它");
{
  const server = new SimulatedStationServer(freshServerState());
  server.failNextAt([1]); // 第 2 笔（0 基索引 1）丢失
  const h2 = server.state.households.find((x) => x.id === "h2");
  const items = [
    { clientItemId: "a", seq: 1, deviceId: "P", kind: "householdUpsert", householdId: "h2", fields: { note: "A" }, bases: { note: JSON.stringify(h2.note) } },
    { clientItemId: "b", seq: 2, deviceId: "P", kind: "householdUpsert", householdId: "h2", fields: { members: 9 }, bases: { members: JSON.stringify(h2.members) } }
  ];
  const r1 = server.submitBatch(3, items);
  assert(r1.results[0].ok, "第1笔收下");
  assert(!r1.results[1].ok && r1.results[1].code === "error", "第2笔未收下");
  const r2 = server.submitBatch(4, [items[1]]);
  assert(r2.duplicate === false && r2.results[0].ok, "第2笔在新批次收下");
  assert(server.state.households.find((x) => x.id === "h2").members === 9, "第2笔值已应用");
  assert(server.state.households.find((x) => x.id === "h2").note === "A", "第1笔结果仍在");
}

console.log("\n[4] 三方合并：只有对方动→收；两边都动→两版并存");
{
  const local = buildSeedHouseholds();
  const localTasks = buildSeedTasks();
  const remote = { clock: 1, households: clone(buildSeedHouseholds()), tasks: clone(buildSeedTasks()), ledger: [] };
  local.find((x) => x.id === "h1").note = "本机改的说明";
  local.find((x) => x.id === "h1").fieldsChangedByDevice.note = "PAD";
  const rh1 = remote.households.find((x) => x.id === "h1");
  rh1.note = "对端改的说明";
  rh1.fieldsChangedByDevice.note = "队部";
  rh1.address = "对端独改的地址";

  const report = mergeRemoteState(local, localTasks, [], remote);
  const merged = report.households.find((x) => x.id === "h1");
  const c = report.conflicts.find((x) => x.field === "note");
  assert(merged.note === "本机改的说明", "本机字段不被对端静默覆盖");
  assert(Boolean(c) && c.status === "待处理" && c.keepBoth, "note 冲突两版并存");
  assert(c.localValue === "本机改的说明" && c.remoteValue === "对端改的说明", "冲突保留两版具体值");
  assert(merged.address === "对端独改的地址", "只有对端改过的 address 自动接收");
}

console.log("\n[5] 重复记录合并：任务转保留记录，已完成保持完成");
{
  const server = new SimulatedStationServer(freshServerState());
  server.state.tasks.push(
    { id: "ka", householdId: "h1", title: "复核A", assignee: "g", priority: "紧急", status: "待接收", due: "d", baseStatus: "待接收", ack: true },
    { id: "kb", householdId: "h1", title: "复核B已完成", assignee: "g", priority: "一般", status: "已完成", due: "d", baseStatus: "已完成", ack: true }
  );
  const r = server.submitBatch(9, [{ clientItemId: "m1", seq: 1, deviceId: "P", kind: "merge", clientId: "cm1", sourceId: "h1", targetId: "h2" }]);
  assert(r.results[0].ok && r.results[0].targetId === "h2", "合并成功，指向保留记录");
  assert(server.state.households.find((x) => x.id === "h1").tombstoned === true, "来源记录在对端变墓碑");
  assert(server.state.tasks.every((t) => t.householdId !== "h1"), "来源下不再挂任务");
  assert(server.state.tasks.find((t) => t.id === "ka")?.householdId === "h2", "待接收任务转到保留记录");
  assert(server.state.tasks.find((t) => t.id === "kb")?.householdId === "h2" && server.state.tasks.find((t) => t.id === "kb")?.status === "已完成", "已完成任务转过去后仍为已完成");
  const r2 = server.submitBatch(10, [{ clientItemId: "m1", seq: 1, deviceId: "P", kind: "merge", clientId: "cm1", sourceId: "h1", targetId: "h2" }]);
  assert(r2.results[0].duplicate === true, "合并重放返回首次结果");
}

console.log("\n[6] 拉取墓碑：本地来源记录被收编，冲突标记已合并");
{
  const local = buildSeedHouseholds();
  const localTasks = buildSeedTasks();
  localTasks.push({ id: "kx", householdId: "h1", title: "本地复核", assignee: "g", priority: "紧急", status: "进行中", due: "d", baseStatus: "进行中", ack: false });
  const remoteState = { clock: 5, households: clone(buildSeedHouseholds()), tasks: clone(buildSeedTasks()), ledger: [] };
  Object.assign(remoteState.households.find((x) => x.id === "h1"), { tombstoned: true, mergedInto: "h2" });
  const priorConflict = [{ id: "x", householdId: "h1", field: "note", localValue: "a", remoteValue: "b", localDevice: "P", remoteDevice: "S", status: "待处理", resolution: null, keepBoth: true }];
  const report = mergeRemoteState(local, localTasks, priorConflict, remoteState);
  assert(!report.households.some((x) => x.id === "h1"), "本地来源记录移除");
  assert(report.households.some((x) => x.id === "h2"), "保留记录仍在");
  assert(report.tasks.find((t) => t.id === "kx")?.householdId === "h2", "本地任务转到保留记录");
  assert(report.repointedTaskIds.some((r) => r.taskId === "kx" && r.from === "h1" && r.to === "h2"), "报告记录任务迁移");
  assert(report.conflicts.find((c) => c.id === "x")?.status === "已合并", "来源记录冲突随合并结案");
}

console.log("\n[7] 任务已完成定案不可回退");
{
  const server = new SimulatedStationServer(freshServerState());
  server.state.tasks[0].status = "已完成";
  const r = server.submitBatch(11, [{ clientItemId: "o1", seq: 1, deviceId: "P", kind: "taskOp", clientId: "co1", taskId: "k1", toStatus: "待接收", taskBase: "进行中" }]);
  assert(r.results[0].ok === true, "返回成功提示");
  assert(server.state.tasks[0].status === "已完成", "已完成状态没有被回退");
}

console.log("\n[8] 对端补传新家庭与复核任务：整条接收，基线对齐");
{
  const seedH = buildSeedHouseholds();
  const remote = {
    clock: 1,
    households: [clone(seedH[0])],
    tasks: [{ id: "z1", householdId: "h1", title: "现场复核", assignee: "复核组", priority: "紧急", status: "待接收", due: "d", baseStatus: "待接收", ack: true }],
    ledger: []
  };
  const report = mergeRemoteState([], [], [], remote);
  assert(report.households.length === 1 && report.households[0].ack === true, "补传家庭整条接收");
  assert(report.tasks[0].id === "z1" && report.tasks[0].ack === true, "补传复核任务整条接收");
  report.households[0].note = "本机后续补记";
  report.households[0].fieldsChangedByDevice.note = "PAD";
  const r2 = mergeRemoteState(report.households, report.tasks, report.conflicts, remote);
  assert(!r2.conflicts.length, "接收后基线已对齐，不误报冲突");
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
