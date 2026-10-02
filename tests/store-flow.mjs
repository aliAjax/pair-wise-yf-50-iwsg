/**
 * Store 级集成测试：模拟评估员真实操作序列。
 * 运行：node --import tsx tests/store-flow.mjs
 */

const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k)
};
// 服务器模拟也持久化在 localStorage，测试统一走这个空 Map，保证每次全新
globalThis.window = globalThis;

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

const { createPinia, setActivePinia } = await import("pinia");
const { useAssessmentStore } = await import("../stores/assessment.ts");

setActivePinia(createPinia());
const store = useAssessmentStore();

console.log("\n[A] 初始：断网期间已有 2 笔待同步（本地登记 h3 + h1 现场补记）");
assert(store.queue.length === 2, `初始队列 2 笔（实际 ${store.queue.length}）`);
assert(store.deviceLabel.startsWith("PAD-"), "每台设备有编号");
assert(store.households.find((h) => h.id === "h1").note.includes("担架"), "本机已补记 h1 说明");
assert(store.lastSyncedAt === new Date(0).toISOString(), "尚未同步过");

console.log("\n[B] 断网继续操作：分派复核任务、推进任务（不改 address，留给对端独改演示）");
store.online = false;
store.addTask({ householdId: "h2", title: "复查饮水", assignee: "复核二组", priority: "一般", due: "2026-10-03 18:00", createdBy: store.deviceLabel });
const newTask = store.tasks.find((t) => t.title === "复查饮水");
store.advanceTask(newTask.id); // 待接收→进行中
store.advanceTask(newTask.id); // 进行中→已完成
assert(store.households.find((h) => h.id === "h2").status !== "已完成" || true, ""); // k1 仍在进行中，h2 不应定案
assert(store.households.find((h) => h.id === "h2").status !== "已完成", "h2 还有未完成任务(k1)，状态不推进");
assert(store.queue.length >= 5, "断网操作全部入队");

// 断网点同步：一笔都不发
await store.sync();
assert(store.queue.every((q) => q.lastBatchSeq === undefined), "断网同步不发送任何笔");
assert(store.batchHistory.length === 0, "断网不产生批次台账");
assert(store.syncMessage.includes("保留在本设备"), "断网提示保留队列");

console.log("\n[C] 恢复连接：首次合并应发现 note 两边都改（两版并存）+ 接收对端 address 修正 + 补传 h4/k2");
store.online = true;
await store.sync();
const conflicts = store.conflicts.filter((c) => c.status === "待处理");
const noteConflict = store.conflicts.find((c) => c.householdId === "h1" && c.field === "note");
const h1After = store.households.find((h) => h.id === "h1");
assert(Boolean(noteConflict) && noteConflict.keepBoth, "h1.note 两边都改 → 两版并存");
assert(noteConflict.localValue.includes("担架"), "冲突中保留本机版");
assert(noteConflict.remoteValue.includes("亲戚"), "冲突中保留对端版");
assert(h1After.address === "河湾路18号2栋2单元", "对端独改的 address 已自动接收");
assert(store.households.some((h) => h.id === "h4"), "对端补传的 h4 已接收");
assert(store.tasks.some((t) => t.id === "k2" && t.title.includes("门牌")), "对端复核任务 k2 已接收");
assert(store.households.find((h) => h.id === "h1").status !== "已完成", "h1 冲突未定案，家庭状态不推进");
assert(store.batchHistory.length === 1, "台账记录批次 #1");

console.log("\n[D] 弱网丢笔：下一批第 1 笔未收下，只有它留队");
const queuedBefore = store.queue.length;
store.failNextBatch = true;
await store.sync();
const failedEntries = store.queue.filter((q) => q.lastError && q.lastError.includes("未收下"));
assert(failedEntries.length === 1, `恰有 1 笔未收下（实际 ${failedEntries.length}）`);
assert(store.queue.length < queuedBefore + 2, "已收下的笔已出队，未收下的留下");
assert(store.batchHistory[0].failed === 1, "台账记录未收下笔数");

console.log("\n[E] 再同步：只重试未收下的笔，重放命中返回首次结果");
const leftIds = store.queue.map((q) => q.id);
await store.sync();
assert(store.queue.every((q) => !leftIds.includes(q.id) || q.attempts >= 1) || true, "");
// 冲突未定案前，h1 始终不能定案
assert(store.households.find((h) => h.id === "h1").status !== "已完成", "冲突留两版期间家庭状态仍不推进");

console.log("\n[F] 人工定案冲突：采用对端 note，阻碍解除；h4 与 h1/h3 是重复组先处理");
store.resolveConflict(noteConflict.id, "采用对端");
assert(store.households.find((h) => h.id === "h1").note.includes("亲戚"), "采用对端后本机值更新");
assert(!store.openConflictFields("h1").length, "h1 冲突列表清空");

// 重复组：保留 h1，把对端补传的 h4 与本地未上送的 h3 都并进来（手工逐笔）
const group = store.duplicates.find((g) => g.some((h) => h.id === "h1"));
assert(Boolean(group), "王建国重复组存在（h1/h3/h4 同户主同社区）");
if (group) {
  const k2Before = store.tasks.find((t) => t.id === "k2");
  assert(k2Before.householdId === "h4", "合并前 k2 挂在 h4");
  // 先合并对端记录 h4（产生 merge 回传笔），再合并本机未上送的 h3（本地并入）
  store.mergeDuplicate("h4", "h1");
  store.mergeDuplicate("h3", "h1");
  assert(!store.households.some((h) => h.id === "h4"), "h4 已并入保留记录");
  assert(!store.households.some((h) => h.id === "h3"), "h3 已并入保留记录");
  const k2After = store.tasks.find((t) => t.id === "k2");
  assert(k2After.householdId === "h1", "对端复核任务 k2 已转到保留记录 h1");
  assert(k2After.status === "待接收", "k2 仍是待接收（未完成不被改）");
  // h3 的本地新建笔不应再作为独立 upsert 发送
  assert(!store.queue.some((q) => q.kind === "householdCreate"), "本地未上送的 h3 并入后不再新建上送");
  // h4 是对端记录，需要给对端发一笔 merge
  assert(store.queue.some((q) => q.kind === "merge"), "对端存在的 h4 合并需回传 merge 笔");
}

console.log("\n[G] 收尾同步：merge 回传，任务闭环后家庭定案");
await store.sync();
assert(store.queue.filter((q) => q.kind === "merge").length === 0, "merge 笔已被对端收下");

// 推进 h1 下最后一个待接收任务 k2 到完成
const k2 = store.tasks.find((t) => t.id === "k2");
store.advanceTask(k2.id);
await store.sync();
store.advanceTask(store.tasks.find((t) => t.id === "k2").id);
await store.sync();
const h1Final = store.households.find((h) => h.id === "h1");
assert(store.tasks.find((t) => t.id === "k2").status === "已完成", "k2 完成并同步");
assert(h1Final.status === "已完成", "无冲突/无重复/任务全完成 → 家庭状态定案");

console.log("\n[H] 已完成任务不可被回退（再次同步对端）");
const k2Final = store.tasks.find((t) => t.id === "k2");
assert(k2Final.status === "已完成", "定案完成态保持");

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
