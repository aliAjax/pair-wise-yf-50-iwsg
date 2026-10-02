import type { FieldConflict, FieldTask, Household, TaskStatus } from "~/stores/assessment";
import { MERGE_FIELDS, jsonEqual } from "./seed";
import type { RemoteState } from "./sync";

export interface MergeReport {
  households: Household[];
  tasks: FieldTask[];
  conflicts: FieldConflict[];
  pulledHouseholdIds: string[];
  pulledTaskIds: string[];
  tombstonedRemoteIds: string[];
  repointedTaskIds: { taskId: string; from: string; to: string }[];
  finalizedHouseholdIds: string[];
}

function fieldString(v: unknown): string {
  return Array.isArray(v) ? v.join("、") : String(v ?? "");
}

const STATUS_RANK: Record<TaskStatus, number> = { 待接收: 0, 进行中: 1, 已完成: 2 };

function conflictId(householdId: string, field: string) {
  return `c-${householdId}-${field}`;
}

/**
 * 与回站队部做三方合并：
 * - 基线（共同祖先）/ 本机现值 / 对端现值逐字段比较；
 * - 只有一边动过的字段直接接收；
 * - 同一字段两边都改过 → 不覆盖、不选边，两版都留下（冲突面板）；
 * - 对端已经合并掉的家庭（墓碑）→ 本地跟随，任务/操作转到保留记录。
 */
export function mergeRemoteState(
  localHouseholds: Household[],
  localTasks: FieldTask[],
  previousConflicts: FieldConflict[],
  remote: RemoteState
): MergeReport {
  const conflicts: FieldConflict[] = previousConflicts.filter((c) => c.status !== "已合并");
  const repointedTaskIds: { taskId: string; from: string; to: string }[] = [];
  const pulledHouseholdIds: string[] = [];
  const pulledTaskIds: string[] = [];
  const finalizedHouseholdIds: string[] = [];

  // 1. 处理对端墓碑（对端已经完成重复记录合并）
  let households = localHouseholds.map((h) => ({ ...h, base: { ...h.base }, fieldsChangedByDevice: { ...h.fieldsChangedByDevice }, mergedFrom: [...h.mergedFrom] }));
  let tasks = localTasks.map((t) => ({ ...t }));
  const tombstonedRemoteIds: string[] = [];

  for (const dead of remote.households.filter((h) => h.tombstoned)) {
    tombstonedRemoteIds.push(dead.id);
    const local = households.find((h) => h.id === dead.id);
    const target = households.find((h) => h.id === dead.mergedInto) ?? remote.households.find((h) => h.id === dead.mergedInto);
    // 本机从未上送（ack=false）的记录不可能在对端存在真实墓碑，防止对端脏数据静默删掉本地登记
    if (local && local.ack === false) continue;
    if (!local || !dead.mergedInto) continue;

    if (target) {
      // 先把本机来源记录的现场数据并入保留记录（与手工合并同规则，不产生新冲突）
      target.needs = Array.from(new Set([...target.needs, ...local.needs]));
      target.vulnerable = Array.from(new Set([...target.vulnerable, ...local.vulnerable]));
      if (local.note && !target.note.includes(local.note)) target.note = `${target.note}；合并来源 ${local.address}`;
      if (!target.mergedFrom.includes(local.id)) target.mergedFrom.push(local.id);
    }
    tasks.forEach((t) => {
      if (t.householdId === local.id) {
        t.householdId = dead.mergedInto!;
        repointedTaskIds.push({ taskId: t.id, from: local.id, to: dead.mergedInto! });
      }
    });
    conflicts
      .filter((c) => c.householdId === local.id)
      .forEach((c) => {
        c.status = "已合并";
        c.resolution = `随重复记录合并到 ${dead.mergedInto}`;
      });
    households = households.filter((h) => h.id !== local.id);
  }

  // 2. 逐家庭逐字段三方合并
  for (const remoteH of remote.households.filter((h) => !h.tombstoned)) {
    const local = households.find((h) => h.id === remoteH.id);

    if (!local) {
      // 对端补传的新家庭：整条接收，基线直接落到对端现值
      const inserted: Household = { ...JSON.parse(JSON.stringify(remoteH)), tombstoned: undefined, mergedInto: undefined, ack: true };
      inserted.base = {};
      for (const f of MERGE_FIELDS) inserted.base[f] = JSON.stringify(remoteH[f]);
      inserted.statusBase = remoteH.status;
      households.push(inserted);
      pulledHouseholdIds.push(remoteH.id);
      continue;
    }

    // 仅当本地也存在该家庭时才做逐字段三方合并；
    // 本地独有（对端还没收到）的家庭不在此循环内，保持原样
    for (const field of MERGE_FIELDS) {
      const localVal = local[field];
      const remoteVal = remoteH[field];
      const baseRaw = local.base[field];
      const baseVal = baseRaw === undefined ? undefined : JSON.parse(baseRaw);

      if (jsonEqual(localVal, remoteVal)) continue;
      const localChanged = baseRaw === undefined ? true : !jsonEqual(localVal, baseVal);
      const remoteChanged = baseRaw === undefined ? !jsonEqual(remoteVal, localVal) : !jsonEqual(remoteVal, baseVal);

      if (!localChanged && remoteChanged) {
        // 只有对端动过：接收对方字段，本地不视为未同步修改
        (local as unknown as Record<string, unknown>)[field] = JSON.parse(JSON.stringify(remoteVal));
        local.fieldsChangedByDevice[field] = remoteH.fieldsChangedByDevice?.[field] ?? "队部终端";
        local.base[field] = JSON.stringify(remoteVal);
      } else if (localChanged && !remoteChanged) {
        // 只有本机动过：保留本机值，同时把基线前移到对端（=基线）现值
        local.base[field] = JSON.stringify(remoteVal);
      } else if (localChanged && remoteChanged) {
        // 两边都改过同一字段：两版都留下，等人工处理，任何一边都不覆盖
        const id = conflictId(local.id, field);
        if (!conflicts.some((c) => c.id === id && c.status === "待处理")) {
          conflicts.push({
            id,
            householdId: local.id,
            field,
            localValue: fieldString(localVal),
            remoteValue: fieldString(remoteVal),
            localDevice: local.fieldsChangedByDevice?.[field] ?? "本机",
            remoteDevice: remoteH.fieldsChangedByDevice?.[field] ?? "队部终端",
            status: "待处理",
            resolution: null,
            keepBoth: true
          });
        }
      }
    }

    // 家庭状态：未定案不推进；对端已定案的完成态可收敛
    if (remoteH.status === "已完成" && local.status !== "已完成") {
      local.status = "已完成";
      local.statusBase = "已完成";
      finalizedHouseholdIds.push(local.id);
    } else if (remoteH.status !== local.status && local.status === local.statusBase) {
      local.status = remoteH.status;
      local.statusBase = remoteH.status;
    }
    local.revision = Math.max(local.revision ?? 1, remoteH.revision ?? 1);
  }

  // 3. 任务合并（含对端跟随合并转到保留记录的任务）
  for (const remoteT of remote.tasks) {
    const local = tasks.find((t) => t.id === remoteT.id);
    if (!local) {
      tasks.push({ ...JSON.parse(JSON.stringify(remoteT)), ack: true, baseStatus: remoteT.status });
      pulledTaskIds.push(remoteT.id);
      continue;
    }
    const localChanged = local.status !== (local.baseStatus ?? local.status);
    const remoteChanged = remoteT.status !== (local.baseStatus ?? remoteT.status);
    if (local.status !== remoteT.status) {
      // 已完成定案不可回退；两边都流转时取进度更靠后的，但标记提示由 UI 展示
      if (remoteT.status === "已完成" || (localChanged && remoteChanged && STATUS_RANK[remoteT.status] > STATUS_RANK[local.status])) {
        local.status = remoteT.status;
      }
    }
    if (!localChanged || local.status === remoteT.status) local.baseStatus = remoteT.status;
    // 对端把任务转到了保留记录（我方还没收到墓碑的情况下也跟着转）
    if (remoteT.householdId !== local.householdId && households.some((h) => h.id === remoteT.householdId)) {
      repointedTaskIds.push({ taskId: local.id, from: local.householdId, to: remoteT.householdId });
      local.householdId = remoteT.householdId;
    }
  }

  return { households, tasks, conflicts, pulledHouseholdIds, pulledTaskIds, tombstonedRemoteIds, repointedTaskIds, finalizedHouseholdIds };
}
