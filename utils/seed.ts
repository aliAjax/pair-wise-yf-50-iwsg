import type { FieldTask, Household } from "~/stores/assessment";

/** 参与三方合并（基线 / 本机 / 对端）的字段；家庭状态不参与字段合并 */
export const MERGE_FIELDS = [
  "head",
  "community",
  "address",
  "members",
  "vulnerable",
  "needLevel",
  "needs",
  "note"
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 逐字段保存基线（JSON 串），数组字段按整体比较 */
export function fieldBaseline(h: Pick<Household, MergeField>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of MERGE_FIELDS) out[f] = JSON.stringify(h[f]);
  return out;
}

interface SeedInput {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: Household["needLevel"];
  needs: string[];
  status: Household["status"];
  revision: number;
  note: string;
  deviceUpdatedAt: string;
  origin: Household["origin"];
  ack: boolean;
}

function toHousehold(s: SeedInput): Household {
  const h = {
    ...s,
    statusBase: s.status,
    mergedFrom: [],
    base: {},
    fieldsChangedByDevice: {}
  } as Household;
  h.base = fieldBaseline(h);
  return h;
}

const now = Date.now();

/**
 * 种子数据同时用于本机与“队部回站补传”模拟服务端，
 * 保证首次同步时双方共享同一基线。
 */
export function buildSeedHouseholds(): Household[] {
  const seeds: SeedInput[] = [
    {
      id: "h1",
      head: "王建国",
      community: "河湾社区",
      address: "河湾路18号2单元",
      members: 4,
      vulnerable: ["老人"],
      needLevel: "紧急",
      needs: ["临时安置", "慢病用药"],
      note: "一层受淹，老人行动不便",
      status: "待复核",
      revision: 2,
      deviceUpdatedAt: new Date(now - 12 * 60000).toISOString(),
      origin: "队部",
      ack: true
    },
    {
      id: "h2",
      head: "赵敏",
      community: "新城社区",
      address: "新城三街9号",
      members: 2,
      vulnerable: [],
      needLevel: "一般",
      needs: ["饮用水"],
      note: "饮水库存不足",
      status: "已分派",
      revision: 1,
      deviceUpdatedAt: new Date(now - 35 * 60000).toISOString(),
      origin: "队部",
      ack: true
    },
    {
      id: "h3",
      head: "王建国",
      community: "河湾社区",
      address: "河湾路18号2幢2单元",
      members: 4,
      vulnerable: ["老人"],
      needLevel: "紧急",
      needs: ["临时安置", "慢病用药"],
      note: "疑似重复登记",
      status: "待评估",
      revision: 1,
      deviceUpdatedAt: new Date(now).toISOString(),
      origin: "本地",
      ack: false
    }
  ];
  return seeds.map(toHousehold);
}

export function buildSeedTasks(): FieldTask[] {
  return [
    {
      id: "k1",
      householdId: "h2",
      title: "配送饮用水",
      assignee: "后勤二组",
      priority: "一般",
      status: "进行中",
      due: "2026-10-03 16:00",
      baseStatus: "进行中",
      ack: true,
      createdBy: "队部值班员"
    }
  ];
}
