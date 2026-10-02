import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";
export type OpStatus = "待发送" | "已收下" | "失败";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  /** 基线版本：本次记录偏离的是哪个已同步版本 */
  baselineVersion: number;
  /** 来源设备编号 */
  deviceId: string;
  deviceUpdatedAt: string;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export interface PendingChange {
  id: string;
  /** 操作编号：幂等键，重放时服务端只认第一次结果 */
  opId: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
  /** 发起设备编号 */
  deviceId: string;
  /** 基线版本：该操作基于哪一版数据 */
  baselineVersion: number;
  status: OpStatus;
  attempts: number;
  /** 关联的家庭记录 id，合并重复记录时随转移到保留记录 */
  refId?: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
  deviceId?: string;
}

export interface SyncReport {
  accepted: number;
  failed: number;
  conflicts: number;
  replayed: number;
}

interface BaselineSnapshot {
  version: number;
  deviceId: string;
  fields: Record<string, unknown>;
}

const KEY = "pair-wise-yf-50/assessment";

/** 可离线合并的字段（status 由流程推进，不参与字段级合并） */
const MERGE_FIELDS = ["head", "community", "address", "members", "vulnerable", "needLevel", "needs", "note"] as const;

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, baselineVersion: 1, deviceId: "seed-device", deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, baselineVersion: 1, deviceId: "seed-device", deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, baselineVersion: 1, deviceId: "seed-device", deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];

/**
 * 已同步基线：记录每个字段“上一次三方合并时的共同祖先”。
 * h1 的基线比种子更旧，用来演示本机与队友设备对同一字段都做过修改。
 */
const seedBaselines: Record<string, BaselineSnapshot> = {
  h1: {
    version: 1,
    deviceId: "seed-device",
    fields: { head: "王建国", community: "河湾社区", address: "河湾路18号", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], note: "一层受淹" }
  },
  h2: {
    version: 1,
    deviceId: "seed-device",
    fields: { head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], note: "饮水库存不足" }
  },
  h3: {
    version: 1,
    deviceId: "seed-device",
    fields: { head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], note: "疑似重复登记" }
  }
};

const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

/** 队友设备上的离线修改（模拟弱网期间对方回站补传的内容） */
const peerDevice = "队友-设备B";
const peerPatches: Record<string, Partial<Household>> = {
  h1: { address: "河湾路18号2栋2单元", note: "远端更新：一层受淹已安置，需持续跟进" },
  h2: { needLevel: "高" }
};

function isEqual(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function displayValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const deviceId = ref(initial?.deviceId ?? (typeof window !== "undefined" ? crypto.randomUUID() : "seed-device"));
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const baselines = ref<Record<string, BaselineSnapshot>>(initial?.baselines ?? seedBaselines);
  /** 服务端已收下的操作编号登记表：重放时凭 opId 去重，只拿第一次结果 */
  const acceptedOpIds = ref<string[]>(initial?.acceptedOpIds ?? []);
  /** 已合并过远端补丁的家庭：重放时不重复三方合并、不重复出冲突 */
  const mergedPeerIds = ref<string[]>(initial?.mergedPeerIds ?? []);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.filter((item) => item.status !== "已收下").length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function enqueue(entity: string, action: string, detail: string, refId?: string, baselineOverride?: number) {
    const household = refId ? households.value.find((item) => item.id === refId) : undefined;
    queue.value.unshift({
      id: crypto.randomUUID(),
      opId: crypto.randomUUID(),
      entity,
      action,
      detail,
      time: new Date().toISOString(),
      deviceId: deviceId.value,
      baselineVersion: baselineOverride ?? household?.baselineVersion ?? 0,
      status: "待发送",
      attempts: 0,
      refId
    });
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "baselineVersion" | "deviceId" | "deviceUpdatedAt">) {
    const id = crypto.randomUUID();
    households.value.unshift({ ...input, id, status: "待评估", version: 1, baselineVersion: 1, deviceId: deviceId.value, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "新增", input.head, id, 0);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "修改", `${household.head}：${Object.keys(patch).join("、")}`, id);
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    // 现场复核任务转到保留记录：已完成任务保持完成，状态原样保留
    tasks.value.forEach((task) => {
      if (task.householdId === sourceId) task.householdId = targetId;
    });
    // 待同步操作转到保留记录，重放时仍按原 opId 去重
    queue.value.forEach((op) => {
      if (op.refId === sourceId) op.refId = targetId;
    });
    // 未定案前不推进家庭状态：status 不在此改动
    households.value = households.value.filter((item) => item.id !== sourceId);
    enqueue("重复记录", "合并", `${source.head} → ${target.address}`, targetId);
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    tasks.value.unshift({ ...input, id: crypto.randomUUID(), status: "待接收" });
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    enqueue("任务", "分派", `${input.title} / ${input.assignee}`, input.householdId);
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
    }
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`, task.householdId);
  }

  /**
   * 字段级三方合并：以最后一次同步的基线为共同祖先。
   * 只接收对方没动过的字段（本机未改、对方改了 → 采用远端）；
   * 同一字段两边都改过 → 留两版冲突，不静默覆盖。
   */
  function applyThreeWayMerge(household: Household, peerPatch: Partial<Household> | undefined): { conflicts: FieldConflict[]; acceptedFields: string[] } {
    const base = baselines.value[household.id];
    const conflicts: FieldConflict[] = [];
    const acceptedFields: string[] = [];
    const mergedFields: Record<string, unknown> = {};
    for (const field of MERGE_FIELDS) {
      const baseVal = base?.fields?.[field];
      const localVal = (household as unknown as Record<string, unknown>)[field];
      const remoteVal = peerPatch && field in peerPatch ? (peerPatch as unknown as Record<string, unknown>)[field] : baseVal;
      const localChanged = !!base && !isEqual(localVal, baseVal);
      const remoteChanged = !!peerPatch && field in peerPatch && !isEqual(remoteVal, baseVal);
      if (localChanged && remoteChanged && !isEqual(localVal, remoteVal)) {
        // 同一字段两边都改过：本机版留在记录里，远端版作为冲突留两版
        mergedFields[field] = localVal;
        conflicts.push({
          id: crypto.randomUUID(),
          householdId: household.id,
          field,
          localValue: displayValue(localVal),
          remoteValue: displayValue(remoteVal),
          status: "待处理",
          deviceId: peerDevice
        });
      } else if (!localChanged && remoteChanged) {
        // 对方没动过的字段才不接——这里是本机没动、对方改了，采用远端
        mergedFields[field] = remoteVal;
        acceptedFields.push(field);
      } else {
        mergedFields[field] = localVal;
      }
    }
    const nextVersion = household.version + 1;
    Object.assign(household, mergedFields, { version: nextVersion, baselineVersion: nextVersion, deviceId: deviceId.value, deviceUpdatedAt: new Date().toISOString() });
    baselines.value[household.id] = { version: nextVersion, deviceId: deviceId.value, fields: { ...mergedFields } };
    return { conflicts, acceptedFields };
  }

  async function simulateSync(): Promise<SyncReport> {
    if (syncing.value) return { accepted: 0, failed: 0, conflicts: 0, replayed: 0 };
    syncing.value = true;
    const report: SyncReport = { accepted: 0, failed: 0, conflicts: 0, replayed: 0 };
    const pending = queue.value.filter((item) => item.status !== "已收下");
    const firstBatch = pending.every((item) => item.attempts === 0);
    let networkDown = false;
    await new Promise((resolve) => setTimeout(resolve, 650));
    for (const op of pending) {
      op.attempts += 1;
      // 重放去重：同一操作编号服务端只认第一次结果，不重复落库
      if (acceptedOpIds.value.includes(op.opId)) {
        op.status = "已收下";
        report.replayed += 1;
        continue;
      }
      if (networkDown) {
        op.status = "失败";
        report.failed += 1;
        continue;
      }
      try {
        // 新增 / 修改 / 合并 / 任务分派 / 状态流转：本地已落定，服务端按 opId 收下
        op.status = "已收下";
        acceptedOpIds.value.push(op.opId);
        report.accepted += 1;
        // 模拟弱网断网：首批批量同步时收下第一笔后链路中断，其余失败待重试
        if (firstBatch && pending.length >= 2 && report.accepted === 1) networkDown = true;
      } catch {
        op.status = "失败";
        report.failed += 1;
      }
    }
    // 同步链路打通后，服务端推送队友设备的远端修改：按基线做字段级三方合并。
    // 重放时已合并过的家庭不再合并，避免重复出冲突、重复盖字段。
    if (report.accepted > 0) {
      for (const household of households.value) {
        if (mergedPeerIds.value.includes(household.id)) continue;
        const patch = peerPatches[household.id];
        if (!patch) continue;
        const { conflicts: found } = applyThreeWayMerge(household, patch);
        report.conflicts += found.length;
        conflicts.value.unshift(...found);
        mergedPeerIds.value.push(household.id);
      }
    }
    lastSyncedAt.value = new Date().toISOString();
    syncing.value = false;
    return report;
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict) return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") {
      (household as unknown as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
      if (baselines.value[household.id]) baselines.value[household.id].fields[conflict.field] = conflict.remoteValue;
    }
    conflict.status = resolution;
    if (household) {
      household.version += 1;
      household.baselineVersion = household.version;
    }
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, conflicts, baselines, acceptedOpIds, mergedPeerIds, lastSyncedAt, deviceId], () => {
      localStorage.setItem(KEY, JSON.stringify({
        deviceId: deviceId.value,
        households: households.value,
        tasks: tasks.value,
        queue: queue.value,
        conflicts: conflicts.value,
        baselines: baselines.value,
        acceptedOpIds: acceptedOpIds.value,
        mergedPeerIds: mergedPeerIds.value,
        lastSyncedAt: lastSyncedAt.value
      }));
    }, { deep: true });
  }

  return {
    households, tasks, queue, conflicts, baselines, acceptedOpIds, online, lastSyncedAt, syncing, deviceId,
    metrics, duplicates,
    addHousehold, updateHousehold, mergeDuplicate, addTask, advanceTask,
    simulateSync, resolveConflict, enqueue
  };
});
