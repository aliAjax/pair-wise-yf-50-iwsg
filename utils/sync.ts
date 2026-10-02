import type { FieldTask, Household, HouseholdStatus, TaskStatus } from "../stores/assessment";
import { MERGE_FIELDS, buildSeedHouseholds, buildSeedTasks, jsonEqual } from "./seed";

/** 对端（队部回站补传终端）的记录形态：被合并掉的家庭保留墓碑 */
export interface RemoteHousehold extends Household {
  tombstoned?: boolean;
  mergedInto?: string | null;
}
export interface RemoteTask extends FieldTask {}

export interface MergeLedgerEntry {
  id: string;
  clientId: string;
  sourceId: string;
  targetId: string;
  at: string;
  device: string;
}

export interface RemoteState {
  clock: number;
  households: RemoteHousehold[];
  tasks: RemoteTask[];
  ledger: MergeLedgerEntry[];
}

export type ItemKind = "householdUpsert" | "merge" | "taskUpsert" | "taskOp";

/** 新建任务笔中随包发送的字段（编号由本机给出，服务端沿用） */
export type TaskPayload = Pick<FieldTask, "householdId" | "title" | "assignee" | "priority" | "status" | "due"> & { createdBy?: string };

/** 续作批次中的一笔：带编号（seq）、设备（deviceId）和基线（base*） */
export interface BatchItem {
  clientItemId: string;
  seq: number;
  kind: ItemKind;
  deviceId: string;
  baseRevision?: number;
  baseHash?: string;
  householdId?: string;
  clientId?: string;
  fields?: Record<string, unknown>;
  bases?: Record<string, string>;
  statusPatch?: HouseholdStatus;
  sourceId?: string;
  targetId?: string;
  task?: TaskPayload;
  taskId?: string;
  toStatus?: TaskStatus;
  taskBase?: TaskStatus;
}

export interface FieldReject {
  field: string;
  serverValue: unknown;
  incomingValue: unknown;
}

export interface ItemResult {
  clientItemId: string;
  ok: boolean;
  duplicate?: boolean;
  code?: "conflict" | "stale" | "error";
  message?: string;
  acceptedFields?: string[];
  rejected?: FieldReject[];
  targetId?: string;
}

export interface BatchResponse {
  batchSeq: number;
  /** 为 true 表示这是重发：已收下的笔返回的是第一次的结果 */
  duplicate: boolean;
  results: ItemResult[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function shortHash(value: string): string {
  let h1 = 0xdeadbeef;
  for (let i = 0; i < value.length; i++) {
    h1 = Math.imul(h1 ^ value.charCodeAt(i), 2654435761);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

export function baselineHash(base: Record<string, string>): string {
  return shortHash(MERGE_FIELDS.map((f) => `${f}=${base[f] ?? ""}`).join("|"));
}

let serverSingleton: SimulatedStationServer | null = null;
const SERVER_KEY = "pair-wise-yf-50/station-server";

/**
 * 模拟“队部回站”后的对端：
 * - 同事在站里改过记录、补传过一条重复家庭和一条现场复核任务；
 * - 批次按 batchSeq 幂等，重发只回放第一次的结果，未收下的笔才重新处理；
 * - 家庭字段按“对端现值 vs 我方基线”逐字段验收，不让整笔覆盖。
 */
export class SimulatedStationServer {
  state: RemoteState;
  private seenBatches = new Set<number>();
  private batchCache: Record<number, Record<string, ItemResult>> = {};
  private clientEntities: Record<string, { type: string; id: string }> = {};
  /** 下一批中按流水号丢弃（模拟弱网丢包），一次性生效，服务器不收下 */
  transientFailPositions = new Set<number>();

  constructor(initial: RemoteState) {
    this.state = initial;
  }

  static instance(): SimulatedStationServer {
    if (serverSingleton) return serverSingleton;
    serverSingleton = new SimulatedStationServer(SimulatedStationServer.bootstrap());
    return serverSingleton;
  }

  private static bootstrap(): RemoteState {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem(SERVER_KEY);
      if (raw) {
        try {
          return JSON.parse(raw) as RemoteState;
        } catch {
          /* 损坏则重建 */
        }
      }
    }
    // h3 是本机断网期间的本地登记（ack=false），不在对端初始状态里
    const households = clone(buildSeedHouseholds().filter((h) => h.ack)) as RemoteHousehold[];
    const tasks = clone(buildSeedTasks());

    // —— 队部回站后补传的现场情况 ——
    const h1 = households.find((h) => h.id === "h1")!;
    h1.address = "河湾路18号2栋2单元"; // 同事修正了楼栋写法
    h1.note = "一层受淹，老人行动不便；队部电话复核：老人暂投亲戚家";
    h1.revision = 3;
    h1.deviceUpdatedAt = new Date(Date.now() - 4 * 60000).toISOString();
    h1.fieldsChangedByDevice = { ...h1.fieldsChangedByDevice, address: "队部终端", note: "队部终端" };
    // 注意：h1.base 保持共同基线不动，用来支撑三方合并判定

    const h4: RemoteHousehold = {
      id: "h4",
      head: "王建国",
      community: "河湾社区",
      address: "河湾路18号2栋2单元202室",
      members: 4,
      vulnerable: ["老人"],
      needLevel: "紧急",
      needs: ["临时安置", "棉被"],
      note: "回站补传登记，与河湾路18号疑似同一户",
      status: "待复核",
      revision: 1,
      deviceUpdatedAt: new Date(Date.now() - 3 * 60000).toISOString(),
      origin: "队部",
      mergedFrom: [],
      ack: true,
      base: {},
      statusBase: "待复核",
      fieldsChangedByDevice: {},
      tombstoned: false,
      mergedInto: null
    };
    h4.base = Object.fromEntries(MERGE_FIELDS.map((f) => [f, JSON.stringify(h4[f])]));
    households.push(h4);

    tasks.push({
      id: "k2",
      householdId: "h4",
      title: "现场复核户主与门牌",
      assignee: "复核一组",
      priority: "紧急",
      status: "待接收",
      due: "2026-10-02 18:00",
      clientId: "srv-k2",
      createdBy: "队部终端",
      baseStatus: "待接收",
      ack: true
    });

    const state: RemoteState = { clock: 3, households, tasks, ledger: [] };
    if (typeof window !== "undefined") localStorage.setItem(SERVER_KEY, JSON.stringify(state));
    return state;
  }

  private persist() {
    if (typeof window !== "undefined") localStorage.setItem(SERVER_KEY, JSON.stringify(this.state));
  }

  getState(): RemoteState {
    return clone(this.state);
  }

  failNextAt(positions: number[]) {
    positions.forEach((p) => this.transientFailPositions.add(p));
  }

  submitBatch(batchSeq: number, items: BatchItem[]): BatchResponse {
    const duplicate = this.seenBatches.has(batchSeq);
    this.seenBatches.add(batchSeq);
    const cache = (this.batchCache[batchSeq] ??= {});
    const results: ItemResult[] = [];

    for (const item of items) {
      // 重发：已收下的笔只回放第一次结果
      const cached = cache[item.clientItemId];
      if (cached) {
        results.push({ ...cached, duplicate: true });
        continue;
      }
      // 模拟弱网丢包：不收下、不缓存，下批重试时重新处理
      if (this.transientFailPositions.has(item.seq - 1)) {
        this.transientFailPositions.delete(item.seq - 1);
        results.push({
          clientItemId: item.clientItemId,
          ok: false,
          code: "error",
          message: "弱网中断，对端未收下该笔"
        });
        continue;
      }

      let result: ItemResult;
      switch (item.kind) {
        case "householdUpsert":
          result = this.applyHouseholdUpsert(item);
          break;
        case "merge":
          result = this.applyMerge(item);
          break;
        case "taskUpsert":
          result = this.applyTaskUpsert(item);
          break;
        case "taskOp":
          result = this.applyTaskOp(item);
          break;
      }
      // error 以外的结果都视为对端已收下，缓存为“第一次结果”
      if (result.code !== "error") cache[item.clientItemId] = result;
      results.push(result);
    }

    this.state.clock += 1;
    this.persist();
    return { batchSeq, duplicate, results };
  }

  private findHousehold(id: string): RemoteHousehold | undefined {
    return this.state.households.find((h) => h.id === id);
  }

  private applyHouseholdUpsert(item: BatchItem): ItemResult {
    // 跨批次的创建幂等：同一 clientId 只认第一次
    if (item.clientId && this.clientEntities[item.clientId]) {
      const known = this.clientEntities[item.clientId];
      return { clientItemId: item.clientItemId, ok: true, duplicate: true, targetId: known.id, message: "重复提交，已返回首次结果" };
    }

    let h = item.householdId ? this.findHousehold(item.householdId) : undefined;
    if (!h) {
      // 沿用终端给出的家庭编号；终端没给时用服务端独立前缀，避免编号空间撞号
      let newId = item.householdId ?? `srv-${Math.random().toString(36).slice(2, 10)}`;
      while (newId !== item.householdId && this.state.households.some((x) => x.id === newId)) {
        newId = `srv-${Math.random().toString(36).slice(2, 10)}`;
      }
      h = {
        id: newId,
        head: "",
        community: "",
        address: "",
        members: 0,
        vulnerable: [],
        needLevel: "一般",
        needs: [],
        note: "",
        status: item.statusPatch ?? "待评估",
        statusBase: item.statusPatch ?? "待评估",
        revision: 1,
        deviceUpdatedAt: new Date().toISOString(),
        origin: item.deviceId,
        mergedFrom: [],
        ack: true,
        base: {},
        fieldsChangedByDevice: {},
        tombstoned: false,
        mergedInto: null
      };
      this.state.households.push(h);
      if (item.clientId) this.clientEntities[item.clientId] = { type: "household", id: h.id };
    } else if (h.tombstoned) {
      return {
        clientItemId: item.clientItemId,
        ok: false,
        code: "stale",
        targetId: h.mergedInto ?? undefined,
        message: `该记录已被对端合并到保留记录 ${h.mergedInto ?? ""}`
      };
    }

    const acceptedFields: string[] = [];
    const rejected: FieldReject[] = [];
    for (const f of MERGE_FIELDS) {
      if (!item.fields || !(f in item.fields)) continue;
      const incoming = item.fields[f];
      const baseRaw = item.bases?.[f];
      const serverChanged = baseRaw !== undefined && !jsonEqual(h[f], JSON.parse(baseRaw));
      if (serverChanged) {
        rejected.push({ field: f, serverValue: h[f], incomingValue: incoming });
      } else {
        (h as unknown as Record<string, unknown>)[f] = incoming;
        h.fieldsChangedByDevice[f] = item.deviceId;
        acceptedFields.push(f);
      }
    }

    let message: string | undefined;
    if (item.statusPatch && item.statusPatch !== h.status) {
      const open = this.state.tasks.some((t) => t.householdId === h.id && t.status !== "已完成");
      if (item.statusPatch === "已完成" && open) {
        message = "家庭尚有未完成的现场任务，状态保持不推进";
      } else {
        h.status = item.statusPatch;
        h.statusBase = h.status;
      }
    }

    if (acceptedFields.length) {
      h.revision += 1;
      h.deviceUpdatedAt = new Date().toISOString();
    }
    return {
      clientItemId: item.clientItemId,
      ok: rejected.length === 0,
      code: rejected.length ? "conflict" : undefined,
      message,
      acceptedFields,
      rejected
    };
  }

  private applyMerge(item: BatchItem): ItemResult {
    if (item.clientId && this.clientEntities[item.clientId]) {
      const known = this.clientEntities[item.clientId];
      return { clientItemId: item.clientItemId, ok: true, duplicate: true, targetId: known.id, message: "合并已处理过，返回首次结果" };
    }
    const source = item.sourceId ? this.findHousehold(item.sourceId) : undefined;
    const target = item.targetId ? this.findHousehold(item.targetId) : undefined;
    if (!source || !target) {
      return { clientItemId: item.clientItemId, ok: false, code: "error", message: "合并对象不存在" };
    }
    if (source.tombstoned) {
      if (source.mergedInto === target.id) {
        return { clientItemId: item.clientItemId, ok: true, duplicate: true, targetId: target.id, message: "重复合并，已返回首次结果" };
      }
      return { clientItemId: item.clientItemId, ok: false, code: "stale", targetId: source.mergedInto ?? undefined, message: `来源记录已被合并到 ${source.mergedInto ?? ""}` };
    }

    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    if (!target.note.includes(source.address)) {
      target.note = `${target.note}；合并来源 ${source.address}`;
    }
    target.mergedFrom.push(source.id);
    target.revision += 1;
    target.deviceUpdatedAt = new Date().toISOString();

    // 现场复核任务随记录转到保留记录，已完成的仍是已完成
    this.state.tasks.forEach((t) => {
      if (t.householdId === source.id) t.householdId = target.id;
    });

    source.tombstoned = true;
    source.mergedInto = target.id;
    this.state.ledger.push({
      id: crypto.randomUUID(),
      clientId: item.clientId ?? item.clientItemId,
      sourceId: source.id,
      targetId: target.id,
      at: new Date().toISOString(),
      device: item.deviceId
    });
    if (item.clientId) this.clientEntities[item.clientId] = { type: "merge", id: target.id };
    return { clientItemId: item.clientItemId, ok: true, targetId: target.id, acceptedFields: ["needs", "vulnerable", "note", "tasks"] };
  }

  private applyTaskUpsert(item: BatchItem): ItemResult {
    if (item.clientId && this.clientEntities[item.clientId]) {
      const known = this.clientEntities[item.clientId];
      return { clientItemId: item.clientItemId, ok: true, duplicate: true, targetId: known.id, message: "任务已创建，返回首次结果" };
    }
    if (!item.task || !item.householdId) {
      return { clientItemId: item.clientItemId, ok: false, code: "error", message: "任务内容缺失" };
    }
    // 沿用我方任务编号，重放不会再产生第二条
    const id = item.taskId ?? `t${Math.random().toString(36).slice(2, 8)}`;
    if (this.state.tasks.some((t) => t.id === id)) {
      return { clientItemId: item.clientItemId, ok: true, duplicate: true, targetId: id, message: "同编号任务已存在" };
    }
    this.state.tasks.push({
      id,
      householdId: item.householdId!,
      title: item.task!.title,
      assignee: item.task!.assignee,
      priority: item.task!.priority,
      status: item.task!.status,
      due: item.task!.due,
      createdBy: item.task!.createdBy ?? item.deviceId,
      baseStatus: item.task!.status,
      ack: true,
      clientId: item.clientId
    });
    if (item.clientId) this.clientEntities[item.clientId] = { type: "task", id };
    return { clientItemId: item.clientItemId, ok: true, targetId: id };
  }

  private applyTaskOp(item: BatchItem): ItemResult {
    if (item.clientId && this.clientEntities[item.clientId]) {
      return { clientItemId: item.clientItemId, ok: true, duplicate: true, message: "状态流转已处理，返回首次结果" };
    }
    const task = this.state.tasks.find((t) => t.id === item.taskId);
    if (!task) return { clientItemId: item.clientItemId, ok: false, code: "stale", message: "任务不存在或已被对端清理" };
    // 已定案的完成状态不可回退
    if (task.status === "已完成") {
      return { clientItemId: item.clientItemId, ok: true, message: "对端任务已完成，保持完成" };
    }
    if (item.taskBase !== undefined && task.status !== item.taskBase) {
      return {
        clientItemId: item.clientItemId,
        ok: false,
        code: "conflict",
        message: `任务状态已被对端改为「${task.status}」，请先合并再提交`
      };
    }
    task.status = item.toStatus ?? task.status;
    if (item.clientId) this.clientEntities[item.clientId] = { type: "taskOp", id: task.id };

    // 对端侧：家庭最后一项任务完成后才允许推进家庭状态
    if (task.status === "已完成") {
      const h = this.findHousehold(task.householdId);
      const open = this.state.tasks.some((t) => t.householdId === task.householdId && t.status !== "已完成");
      if (h && !open && h.status !== "已完成") {
        h.status = "已完成";
        h.statusBase = "已完成";
        h.revision += 1;
      }
    }
    return { clientItemId: item.clientItemId, ok: true };
  }
}
