import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { MERGE_FIELDS, fieldBaseline, buildSeedHouseholds, buildSeedTasks, jsonEqual } from "~/utils/seed";
import { SimulatedStationServer, baselineHash, type BatchItem, type ItemResult } from "~/utils/sync";
import { mergeRemoteState } from "~/utils/merge";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  note: string;
  status: HouseholdStatus;
  statusBase: HouseholdStatus;
  revision: number;
  deviceUpdatedAt: string;
  origin: string;
  /** 对端是否已收下（false=本地新建尚未确认） */
  ack: boolean;
  clientId?: string;
  mergedFrom: string[];
  /** 逐字段共同基线（JSON 串），三方合并依据 */
  base: Record<string, string>;
  fieldsChangedByDevice: Record<string, string>;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
  baseStatus: TaskStatus;
  ack: boolean;
  clientId?: string;
  createdBy?: string;
}

export type QueueKind = "householdCreate" | "householdUpdate" | "merge" | "taskCreate" | "taskOp";

export interface PendingChange {
  id: string;
  clientId: string;
  kind: QueueKind;
  entity: string;
  action: string;
  detail: string;
  time: string;
  householdId?: string;
  fields?: string[];
  sourceId?: string;
  targetId?: string;
  sourceAck?: boolean;
  taskId?: string;
  toStatus?: TaskStatus;
  taskBase?: TaskStatus;
  lastBatchSeq?: number;
  attempts?: number;
  lastError?: string;
}

export type ConflictStatus = "待处理" | "保留两版" | "采用本机" | "采用对端" | "已合并";

export interface FieldConflict {
  id: string;
  householdId: string;
  field: string;
  localValue: string;
  remoteValue: string;
  localDevice: string;
  remoteDevice: string;
  status: ConflictStatus;
  resolution: string | null;
  keepBoth: boolean;
}

export interface BatchHistoryEntry {
  batchSeq: number;
  deviceId: string;
  sentAt: string;
  total: number;
  accepted: number;
  conflicted: number;
  failed: number;
  duplicate: boolean;
  replayHits: number;
  summary: string;
}

const KEY = "pair-wise-yf-50/assessment/v2";
const DEVICE_KEY = "pair-wise-yf-50/device-id";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function deviceId() {
  if (typeof window === "undefined") return "PAD-SSSR";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `PAD-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

interface PersistShape {
  schema: 2;
  households: Household[];
  tasks: FieldTask[];
  queue: PendingChange[];
  conflicts: FieldConflict[];
  lastSyncedAt: string;
  batchSeq: number;
  batchHistory: BatchHistoryEntry[];
}

function freshState(device: string): PersistShape {
  const households = buildSeedHouseholds();
  const tasks = buildSeedTasks();

  // 本机在断网期间刚改过 h1 的现场说明（基线仍是旧值），
  // 而队部回站也改了同一字段 —— 首次合并即出现“两边都改过”。
  const h1 = households.find((h) => h.id === "h1")!;
  h1.note = "一层受淹，老人行动不便；现场补记：转移需要担架";
  h1.fieldsChangedByDevice.note = device;
  h1.deviceUpdatedAt = new Date().toISOString();

  const h3 = households.find((h) => h.id === "h3")!;
  h3.clientId = "cli-h3";

  const queue: PendingChange[] = [
    {
      id: uid("q"),
      clientId: "cli-h3-create",
      kind: "householdCreate",
      entity: "家庭需求记录",
      action: "新增",
      detail: `${h3.head} / ${h3.address}`,
      time: h3.deviceUpdatedAt,
      householdId: h3.id,
      attempts: 0
    },
    {
      id: uid("q"),
      clientId: uid("cli"),
      kind: "householdUpdate",
      entity: "家庭需求记录",
      action: "修改",
      detail: `${h1.head}：note`,
      time: h1.deviceUpdatedAt,
      householdId: h1.id,
      fields: ["note"],
      attempts: 0
    }
  ];

  return {
    schema: 2,
    households,
    tasks,
    queue,
    conflicts: [],
    lastSyncedAt: new Date(0).toISOString(),
    batchSeq: 0,
    batchHistory: []
  };
}

function loadState(device: string): PersistShape {
  if (typeof window !== "undefined") {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistShape;
        if (parsed.schema === 2 && Array.isArray(parsed.households)) return parsed;
      } catch {
        /* 旧版或损坏数据，回退种子 */
      }
    }
  }
  return freshState(device);
}

export const useAssessmentStore = defineStore("assessment", () => {
  const device = deviceId();
  const initial = loadState(device);

  const households = ref<Household[]>(initial.households);
  const tasks = ref<FieldTask[]>(initial.tasks);
  const queue = ref<PendingChange[]>(initial.queue);
  const conflicts = ref<FieldConflict[]>(initial.conflicts);
  const lastSyncedAt = ref(initial.lastSyncedAt);
  const batchSeq = ref(initial.batchSeq);
  const batchHistory = ref<BatchHistoryEntry[]>(initial.batchHistory ?? []);

  const online = ref(true);
  const syncing = ref(false);
  const syncMessage = ref("");
  const failNextBatch = ref(false);
  const deviceLabel = ref(device);

  // 模拟对端只在浏览器侧（同步动作发生时）构造，SSR 不触碰存储
  function station() {
    return SimulatedStationServer.instance();
  }

  // ---------- 派生数据 ----------

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    // 同 key 的记录数 > 2 时，若上一版 UI 已选择过保留记录，保持选择稳定（由页面 keepChoice 自行维护）
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function duplicateGroupOf(id: string): Household[] {
    return duplicates.value.find((group) => group.some((h) => h.id === id)) ?? [];
  }

  function openConflictFields(householdId: string) {
    return conflicts.value.filter((c) => c.householdId === householdId && (c.status === "待处理" || c.status === "保留两版"));
  }

  function conflictPending(conflict: FieldConflict): boolean {
    return conflict.status === "待处理" || conflict.status === "保留两版";
  }

  /** 推进家庭状态前必须排除的未定案事项 */
  function blockers(householdId: string): string[] {
    const reasons: string[] = [];
    if (openConflictFields(householdId).length) reasons.push("字段冲突尚未定案（保留两版）");
    if (duplicateGroupOf(householdId).length > 1) reasons.push("仍属于疑似重复记录，未合并");
    const open = tasks.value.filter((t) => t.householdId === householdId && t.status !== "已完成");
    if (open.length) reasons.push(`${open.length} 个现场任务未完成`);
    return reasons;
  }

  function dirtyFields(h: Household): string[] {
    return MERGE_FIELDS.filter((f) => {
      const current = JSON.stringify(h[f]);
      if (h.base[f] === undefined) return true;
      if (jsonEqual(current, h.base[f])) return false;
      // 冲突未定案（含保留两版）的字段不参与重发
      const c = conflicts.value.find((item) => item.householdId === h.id && item.field === f);
      if (c && conflictPending(c)) return false;
      return true;
    });
  }

  // ---------- 本地操作 ----------

  function addHousehold(input: Omit<Household, "id" | "status" | "statusBase" | "revision" | "deviceUpdatedAt" | "origin" | "ack" | "mergedFrom" | "base" | "fieldsChangedByDevice" | "clientId">) {
    const id = uid("h");
    const household: Household = {
      ...input,
      id,
      status: "待评估",
      statusBase: "待评估",
      revision: 1,
      deviceUpdatedAt: new Date().toISOString(),
      origin: device,
      ack: false,
      clientId: uid("cli"),
      mergedFrom: [],
      base: {},
      fieldsChangedByDevice: {}
    };
    household.base = fieldBaseline(household);
    households.value.unshift(household);
    queue.value.unshift({
      id: uid("q"),
      clientId: household.clientId!,
      kind: "householdCreate",
      entity: "家庭需求记录",
      action: "新增",
      detail: `${household.head} / ${household.address}`,
      time: household.deviceUpdatedAt,
      householdId: id,
      attempts: 0
    });
  }

  function updateHousehold(id: string, patch: Partial<Pick<Household, (typeof MERGE_FIELDS)[number]>>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    const changed = Object.keys(patch).filter((f) =>
      !jsonEqual((household as unknown as Record<string, unknown>)[f], (patch as Record<string, unknown>)[f])
    );
    if (!changed.length) return;
    Object.assign(household, patch, { revision: household.revision + 1, deviceUpdatedAt: new Date().toISOString() });
    changed.forEach((f) => {
      household.fieldsChangedByDevice[f] = device;
    });
    // 本地尚未被对端收下的新建记录，修改并入创建笔，不另起操作
    if (!household.ack) return;
    const existing = queue.value.find((q) => q.kind === "householdUpdate" && q.householdId === id);
    const fields = Array.from(new Set([...(existing?.fields ?? []), ...changed]));
    if (existing) {
      existing.fields = fields;
      existing.detail = `${household.head}：${fields.join("、")}`;
      existing.time = new Date().toISOString();
    } else {
      queue.value.unshift({
        id: uid("q"),
        clientId: uid("cli"),
        kind: "householdUpdate",
        entity: "家庭需求记录",
        action: "修改",
        detail: `${household.head}：${fields.join("、")}`,
        time: new Date().toISOString(),
        householdId: id,
        fields,
        attempts: 0
      });
    }
  }

  /** 合并重复记录：保留 target，现场任务与待同步操作转到保留记录 */
  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target || sourceId === targetId) return;

    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    if (source.note && !target.note.includes(source.note)) target.note = `${target.note}；合并来源 ${source.address}`;
    target.mergedFrom.push(source.id);
    target.revision += 1;

    // 现场复核任务整体转到保留记录；已完成的仍然是已完成
    tasks.value.forEach((t) => {
      if (t.householdId === sourceId) t.householdId = targetId;
    });

    // 待同步操作迁移
    const next: PendingChange[] = [];
    for (const q of queue.value) {
      if (q.kind === "taskCreate" || q.kind === "taskOp") {
        // 任务已转走；taskCreate 行的 householdId 跟随
        const task = tasks.value.find((t) => t.id === q.taskId);
        if (task && q.householdId === sourceId) q.householdId = targetId;
        next.push(q);
      } else if (q.kind === "merge" && (q.sourceId === sourceId || q.targetId === sourceId)) {
        // 来源本身已被别的合并处理，作废
        continue;
      } else if (q.householdId === sourceId) {
        if (q.kind === "householdUpdate") {
          // 来源记录上的字段修改已通过并集/附注并入保留记录，操作不重发
          continue;
        }
        if (q.kind === "householdCreate" && !source.ack) {
          // 本机自建、从未上送的重复记录，直接并入即可
          continue;
        }
        next.push(q);
      } else {
        next.push(q);
      }
    }
    queue.value = next;

    conflicts.value
      .filter((c) => c.householdId === sourceId)
      .forEach((c) => {
        c.status = "已合并";
        c.resolution = `随重复记录合并到 ${target.head}${target.address}`;
      });
    households.value = households.value.filter((item) => item.id !== sourceId);

    if (source.ack) {
      queue.value.unshift({
        id: uid("q"),
        clientId: uid("cli"),
        kind: "merge",
        entity: "重复记录",
        action: "合并",
        detail: `${source.head}（${source.address}）→ 保留 ${target.address}`,
        time: new Date().toISOString(),
        sourceId,
        targetId,
        sourceAck: true,
        attempts: 0
      });
    }

    tryFinalize(targetId);
  }

  function addTask(input: Omit<FieldTask, "id" | "status" | "baseStatus" | "ack" | "clientId">) {
    const id = uid("t");
    const task: FieldTask = {
      ...input,
      id,
      status: "待接收",
      baseStatus: "待接收",
      ack: false,
      clientId: uid("cli")
    };
    tasks.value.unshift(task);
    // 分派任务不直接推进家庭状态；状态只在任务闭环且无其他定案阻碍时收敛
    queue.value.unshift({
      id: uid("q"),
      clientId: task.clientId!,
      kind: "taskCreate",
      entity: "现场复核任务",
      action: "分派",
      detail: `${input.title} / ${input.assignee}`,
      time: new Date().toISOString(),
      householdId: input.householdId,
      taskId: id,
      attempts: 0
    });
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task || task.status === "已完成") return;
    const next: TaskStatus = task.status === "待接收" ? "进行中" : "已完成";
    task.status = next;
    queue.value.unshift({
      id: uid("q"),
      clientId: uid("cli"),
      kind: "taskOp",
      entity: "现场复核任务",
      action: "状态流转",
      detail: `${task.title} → ${next}`,
      time: new Date().toISOString(),
      householdId: task.householdId,
      taskId: task.id,
      toStatus: next,
      taskBase: task.baseStatus,
      attempts: 0
    });
    if (next === "已完成") tryFinalize(task.householdId);
  }

  /** 无未决冲突、无重复分组、无未完成任务时，家庭状态才允许落定 */
  function tryFinalize(householdId: string) {
    const h = households.value.find((item) => item.id === householdId);
    if (!h || h.status === "已完成") return;
    const hasTasks = tasks.value.some((t) => t.householdId === householdId);
    if (!hasTasks) return;
    if (blockers(householdId).length) return;
    h.status = "已完成";
  }

  function tryFinalizeAll() {
    households.value.forEach((h) => tryFinalize(h.id));
  }

  // ---------- 冲突定案 ----------

  function parseStoredValue(field: string, text: string): unknown {
    const sample = households.value.find((h) => field in h);
    const isArray = sample ? Array.isArray((sample as Record<string, unknown>)[field]) : false;
    if (isArray) return text.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    if (sample && typeof (sample as Record<string, unknown>)[field] === "number") return Number(text);
    return text;
  }

  function resolveConflict(id: string, resolution: "采用本机" | "采用对端" | "保留两版") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict) return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    conflict.status = resolution;
    conflict.keepBoth = resolution === "保留两版";
    conflict.resolution =
      resolution === "保留两版"
        ? "两版均保留，家庭状态暂不推进"
        : resolution === "采用对端"
          ? `已采用「${conflict.remoteDevice}」的值`
          : `已采用「${conflict.localDevice}」的值，将在下批次回传对端`;

    if (!household) return;
    if (resolution === "采用对端") {
      const value = parseStoredValue(conflict.field, conflict.remoteValue);
      (household as unknown as Record<string, unknown>)[conflict.field] = value;
      household.base[conflict.field] = JSON.stringify(value);
    } else if (resolution === "采用本机") {
      // 基线前移到对端现值：下一笔带上“我已知晓对端值”的基线，对端验收后收敛为本机值
      household.base[conflict.field] = JSON.stringify(parseStoredValue(conflict.field, conflict.remoteValue));
      if (!household.ack) return;
      const existing = queue.value.find((q) => q.kind === "householdUpdate" && q.householdId === household.id);
      const fields = Array.from(new Set([...(existing?.fields ?? []), conflict.field]));
      if (existing) existing.fields = fields;
      else
        queue.value.unshift({
          id: uid("q"),
          clientId: uid("cli"),
          kind: "householdUpdate",
          entity: "家庭需求记录",
          action: "修改",
          detail: `${household.head}：${conflict.field}（冲突定案：采用本机）`,
          time: new Date().toISOString(),
          householdId: household.id,
          fields,
          attempts: 0
        });
    }
    tryFinalize(household.id);
  }

  // ---------- 续作批次 ----------

  /** 只从“还没被对端收下”的操作构建批次，已收下的不会重发 */
  function buildBatch(): BatchItem[] {
    const rank: Record<QueueKind, number> = {
      householdCreate: 0,
      householdUpdate: 1,
      taskCreate: 2,
      taskOp: 3,
      merge: 4 // 合并放最后：来源若是本机新建，先创建再合并
    };
    const entries = [...queue.value]
      .filter((q) => q.lastBatchSeq === undefined)
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.time.localeCompare(b.time));

    const items: BatchItem[] = [];
    entries.forEach((q, index) => {
      const seq = index + 1;
      const base: BatchItem = { clientItemId: q.id, seq, deviceId: device, clientId: q.clientId, kind: "householdUpsert" };
      const h = q.householdId ? households.value.find((item) => item.id === q.householdId) : undefined;

      if (q.kind === "householdCreate" && h) {
        items.push({
          ...base,
          kind: "householdUpsert",
          householdId: h.id,
          fields: Object.fromEntries(MERGE_FIELDS.map((f) => [f, JSON.parse(JSON.stringify(h[f]))])),
          bases: { ...h.base }
        });
        return;
      }
      if (q.kind === "householdUpdate" && h) {
        const fields = dirtyFields(h).filter((f) => q.fields?.includes(f));
        if (!fields.length) return;
        items.push({
          ...base,
          kind: "householdUpsert",
          householdId: h.id,
          fields: Object.fromEntries(fields.map((f) => [f, JSON.parse(JSON.stringify((h as Record<string, unknown>)[f]))])),
          bases: Object.fromEntries(fields.map((f) => [f, h.base[f]])),
          baseRevision: h.revision,
          baseHash: baselineHash(h.base)
        });
        return;
      }
      if (q.kind === "merge") {
        // 来源是否已上送以合并发生时的快照为准（本地来源记录此时已删除）
        if (!q.sourceAck) return;
        items.push({
          ...base,
          kind: "merge",
          sourceId: q.sourceId,
          targetId: q.targetId,
          baseRevision: households.value.find((item) => item.id === q.targetId)?.revision
        });
        return;
      }
      if (q.kind === "taskCreate") {
        const task = tasks.value.find((t) => t.id === q.taskId);
        if (!task || task.ack) return;
        items.push({
          ...base,
          kind: "taskUpsert",
          householdId: task.householdId,
          taskId: task.id,
          task: {
            householdId: task.householdId,
            title: task.title,
            assignee: task.assignee,
            priority: task.priority,
            status: task.status,
            due: task.due,
            createdBy: task.createdBy
          }
        });
        return;
      }
      if (q.kind === "taskOp") {
        const task = tasks.value.find((t) => t.id === q.taskId);
        if (!task || task.status === task.baseStatus) return;
        items.push({
          ...base,
          kind: "taskOp",
          taskId: task.id,
          toStatus: q.toStatus,
          taskBase: task.baseStatus
        });
      }
    });
    return items;
  }

  function ingestResults(results: ItemResult[], batchSeqValue: number) {
    let accepted = 0;
    let conflicted = 0;
    let failed = 0;
    let replayHits = 0;

    for (const result of results) {
      const entry = queue.value.find((q) => q.id === result.clientItemId);
      if (result.duplicate) replayHits += 1;
      if (!result.ok && result.code === "error") failed += 1;
      if (result.code === "conflict") conflicted += 1;

      if (!entry) continue;
      entry.attempts = (entry.attempts ?? 0) + 1;

      // 对端没收下（弱网/错误）：留在队列，下批只重试这一笔
      if (!result.ok && result.code === "error") {
        entry.lastError = result.message ?? "对端未收下";
        continue;
      }

      if (result.code === "conflict") {
        entry.lastError = result.message ?? "部分字段冲突";
      }

      const household = entry.householdId ? households.value.find((h) => h.id === entry.householdId) : undefined;

      switch (entry.kind) {
        case "householdCreate":
          if (household && result.ok) household.ack = true;
          if (result.ok) accepted += 1;
          if (result.ok) entry.lastBatchSeq = batchSeqValue;
          break;
        case "householdUpdate": {
          // 对端收下的字段基线前移；被拒字段转冲突（两版都留），不覆盖
          const rejectedFields = new Set((result.rejected ?? []).map((r) => r.field));
          for (const f of result.acceptedFields ?? []) {
            if (household) household.base[f] = JSON.stringify((household as Record<string, unknown>)[f]);
          }
          for (const reject of result.rejected ?? []) {
            const exists = conflicts.value.find((c) => c.householdId === household?.id && c.field === reject.field);
            const localValue = household ? String((household as Record<string, unknown>)[reject.field]) : "";
            const remoteValue = Array.isArray(reject.serverValue) ? reject.serverValue.join("、") : String(reject.serverValue ?? "");
            if (exists && exists.status === "待处理") {
              exists.localValue = Array.isArray(reject.incomingValue) ? reject.incomingValue.join("、") : String(reject.incomingValue ?? "");
              exists.remoteValue = remoteValue;
            } else if (!exists) {
              conflicts.value.push({
                id: `c-${household?.id}-${reject.field}`,
                householdId: household?.id ?? "",
                field: reject.field,
                localValue: Array.isArray(reject.incomingValue) ? reject.incomingValue.join("、") : String(reject.incomingValue ?? localValue),
                remoteValue,
                localDevice: device,
                remoteDevice: "队部终端",
                status: "待处理",
                resolution: null,
                keepBoth: true
              });
            }
          }
          // 整笔被字段冲突顶住也算“已收下”，拒掉的字段以冲突形式留下；其余错误（stale 等）稍后拉取收敛
          if (result.code !== "stale") {
            entry.lastBatchSeq = batchSeqValue;
            if (!rejectedFields.size) accepted += 1;
          } else {
            entry.lastError = result.message;
          }
          break;
        }
        case "merge":
          if (result.ok) {
            accepted += 1;
            entry.lastBatchSeq = batchSeqValue;
            const target = households.value.find((h) => h.id === entry.targetId);
            if (target) target.ack = true;
          } else if (result.code === "stale") {
            entry.lastError = result.message ?? "来源已在对端合并";
            // 不落 lastBatchSeq，等拉取把墓碑同步过来后在清理阶段自然移除
          }
          break;
        case "taskCreate": {
          const task = tasks.value.find((t) => t.id === entry.taskId);
          if (result.ok) {
            accepted += 1;
            if (task) task.ack = true;
            entry.lastBatchSeq = batchSeqValue;
          }
          break;
        }
        case "taskOp": {
          const task = tasks.value.find((t) => t.id === entry.taskId);
          if (result.ok) {
            accepted += 1;
            if (task) task.baseStatus = task.status;
            entry.lastBatchSeq = batchSeqValue;
          } else if (result.code === "conflict") {
            entry.lastError = result.message;
          }
          break;
        }
      }
    }

    return { accepted, conflicted, failed, replayHits };
  }

  /** 拉取/合并后，把已被收敛的待同步项清掉（只清“已被对端收下或已无差异”的） */
  function reconcileQueue(remoteTombstones: string[] = []) {
    queue.value = queue.value.filter((q) => {
      if (q.lastBatchSeq !== undefined) return false;
      const h = q.householdId ? households.value.find((item) => item.id === q.householdId) : undefined;

      if (q.kind === "merge") {
        const sourceExists = households.value.some((item) => item.id === q.sourceId);
        const targetExists = households.value.some((item) => item.id === q.targetId);
        // 对端墓碑已在拉取时完成本地合并，或保留记录已不在（极端情况），merge 笔无需再发
        if (!sourceExists || !targetExists) return false;
        // 来源记录本机已先并入、对端也独立合并（墓碑）——同一合并双方都做过，不再重发
        if (q.sourceId && remoteTombstones.includes(q.sourceId)) return false;
        return true;
      }
      if ((q.kind === "householdUpdate" || q.kind === "householdCreate") && !h) return false;
      if (q.kind === "householdUpdate" && h) {
        return dirtyFields(h).some((f) => q.fields?.includes(f));
      }
      if (q.kind === "taskOp") {
        const task = tasks.value.find((t) => t.id === q.taskId);
        return Boolean(task && task.status !== task.baseStatus);
      }
      if (q.kind === "taskCreate") {
        const task = tasks.value.find((t) => t.id === q.taskId);
        return Boolean(task && !task.ack);
      }
      return true;
    });
  }

  async function sync() {
    if (syncing.value) return;
    if (!online.value) {
      syncMessage.value = "仍在断网/弱网状态，全部待同步操作保留在本设备，未向对端发送任何一笔。";
      return;
    }
    syncing.value = true;
    syncMessage.value = "正在组续作批次（编号 / 设备 / 基线）…";

    try {
      const server = station();
      // 模拟弱网往返
      await new Promise((resolve) => setTimeout(resolve, 450));
      const items = buildBatch();

      let seqValue = batchSeq.value;
      let responseSummary = { accepted: 0, conflicted: 0, failed: 0, replayHits: 0, total: items.length, duplicate: false, sentSeq: 0 };

      if (items.length) {
        seqValue = batchSeq.value + 1;
        batchSeq.value = seqValue;
        queue.value.forEach((q) => {
          if (q.lastBatchSeq === undefined && items.some((item) => item.clientItemId === q.id)) {
            q.lastBatchSeq = -seqValue; // 临时占位：标记“本批在途”，失败回滚
          }
        });

        if (failNextBatch.value) {
          server.failNextAt([0]);
          failNextBatch.value = false;
        }
        const response = server.submitBatch(seqValue, items);
        // 先回滚在途占位，再按结果落账
        queue.value.forEach((q) => {
          if (q.lastBatchSeq === -seqValue) q.lastBatchSeq = undefined;
        });
        const summary = ingestResults(response.results, seqValue);
        responseSummary = { ...summary, total: items.length, duplicate: response.duplicate, sentSeq: seqValue };

        batchHistory.value.unshift({
          batchSeq: seqValue,
          deviceId: device,
          sentAt: new Date().toISOString(),
          total: items.length,
          accepted: summary.accepted,
          conflicted: summary.conflicted,
          failed: summary.failed,
          duplicate: response.duplicate,
          replayHits: summary.replayHits,
          summary: ""
        });
        if (batchHistory.value.length > 8) batchHistory.value.length = 8;
      }

      // 无论本批有没有发出，都拉取对端状态做字段级三方合并
      await new Promise((resolve) => setTimeout(resolve, 350));
      const remote = server.getState();
      const report = mergeRemoteState(households.value, tasks.value, conflicts.value, remote);
      households.value = report.households;
      tasks.value = report.tasks;
      conflicts.value = report.conflicts;

      // 墓碑合并后把仍指向旧家庭的待同步操作转到保留记录
      for (const move of report.repointedTaskIds) {
        queue.value.forEach((q) => {
          if (q.householdId === move.from) q.householdId = move.to;
        });
      }

      reconcileQueue(report.tombstonedRemoteIds);
      tryFinalizeAll();

      lastSyncedAt.value = new Date().toISOString();

      const parts: string[] = [];
      if (!responseSummary.total) parts.push("没有未收下的操作需要重发");
      else {
        parts.push(`批次 #${responseSummary.sentSeq} 共 ${responseSummary.total} 笔，对端新收下 ${responseSummary.accepted} 笔`);
        if (responseSummary.duplicate || responseSummary.replayHits)
          parts.push(`重放命中 ${responseSummary.replayHits} 笔，均返回第一次结果，未产生副本`);
        if (responseSummary.failed) parts.push(`${responseSummary.failed} 笔未收下，已留在队列只重试这些`);
        if (responseSummary.conflicted) parts.push(`${responseSummary.conflicted} 笔存在字段冲突，两版均已保留`);
      }
      if (report.pulledHouseholdIds.length) parts.push(`接收对端补传家庭 ${report.pulledHouseholdIds.length} 户`);
      if (report.pulledTaskIds.length) parts.push(`接收对端复核任务 ${report.pulledTaskIds.length} 条`);
      if (report.repointedTaskIds.length) parts.push(`${report.repointedTaskIds.length} 条任务随重复合并转到保留记录`);
      syncMessage.value = parts.join("；");
      if (batchHistory.value[0]) batchHistory.value[0].summary = syncMessage.value;
    } catch (error) {
      syncMessage.value = `同步中断，所有在途笔均未确认收下，下次只重试未收下部分：${error instanceof Error ? error.message : String(error)}`;
      queue.value.forEach((q) => {
        if (typeof q.lastBatchSeq === "number" && q.lastBatchSeq < 0) q.lastBatchSeq = undefined;
      });
    } finally {
      syncing.value = false;
    }
  }

  if (typeof window !== "undefined") {
    watch(
      [households, tasks, queue, conflicts, lastSyncedAt, batchSeq, batchHistory],
      () => {
        const data: PersistShape = {
          schema: 2,
          households: households.value,
          tasks: tasks.value,
          queue: queue.value,
          conflicts: conflicts.value,
          lastSyncedAt: lastSyncedAt.value,
          batchSeq: batchSeq.value,
          batchHistory: batchHistory.value
        };
        localStorage.setItem(KEY, JSON.stringify(data));
      },
      { deep: true }
    );
  }

  return {
    // state
    households,
    tasks,
    queue,
    conflicts,
    online,
    syncing,
    syncMessage,
    failNextBatch,
    lastSyncedAt,
    deviceLabel,
    batchHistory,
    // derived
    metrics,
    duplicates,
    blockers,
    dirtyFields,
    openConflictFields,
    // actions
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    advanceTask,
    resolveConflict,
    sync
  };
});
