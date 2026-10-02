<script setup lang="ts">
import { computed, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type NeedLevel } from "~/stores/assessment";
import { baselineHash } from "~/utils/sync";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");

const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

// 断网期间继续补记：地址与现场说明两个最常被两边同时修改的字段
const editAddress = ref("");
const editNote = ref("");

function startEdit() {
  editAddress.value = selected.value?.address ?? "";
  editNote.value = selected.value?.note ?? "";
}
startEdit();

function saveEdit() {
  if (!selected.value) return;
  store.updateHousehold(selected.value.id, { address: editAddress.value, note: editNote.value });
}

const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});

function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-10-03 18:00", createdBy: store.deviceLabel });
}

function sync() {
  void store.sync();
}

// 每个重复分组中选择保留记录，其余来源的现场任务/待同步操作会转过去
const keepChoice = ref<Record<string, string>>({});
function keepOf(groupId: string, fallback: string) {
  return keepChoice.value[groupId] ?? fallback;
}
function groupId(group: { id: string }[]) {
  return group.map((g) => g.id).sort().join("-");
}
function mergeGroup(group: ReturnType<typeof store.duplicates>[number]) {
  const gid = groupId(group);
  const targetId = keepOf(gid, group[0].id);
  group.filter((h) => h.id !== targetId).forEach((h) => store.mergeDuplicate(h.id, targetId));
}
function tasksOf(householdId: string) {
  return store.tasks.filter((t) => t.householdId === householdId);
}
function hashOf(base: Record<string, string>) {
  return baselineHash(base);
}
function fieldLabel(f: string) {
  return { head: "户主", community: "社区", address: "地址", members: "人数", vulnerable: "特殊照护", needLevel: "需求等级", needs: "需求项", note: "现场说明" }[f] ?? f;
}
function kindLabel(kind: string) {
  return { householdCreate: "家庭新增", householdUpdate: "家庭修改", merge: "重复合并", taskCreate: "任务分派", taskOp: "任务流转" }[kind] ?? kind;
}
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div>
      <nav>
        <button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">
          {{ item }}
          <span v-if="item === '同步队列' && store.queue.length" class="badge">({{ store.queue.length }})</span>
          <span v-if="item === '冲突处理' && store.conflicts.some((c) => c.status === '待处理' || c.status === '保留两版')" class="badge warn">!</span>
        </button>
      </nav>
      <div class="network">
        <small>设备与网络</small>
        <b>{{ browserOnline && store.online ? '在线（回站链路通）' : '弱网 / 离线' }}</b>
        <NSwitch v-model:value="store.online" />
        <small>设备编号 {{ store.deviceLabel }}</small>
        <small>最近同步 {{ new Date(store.lastSyncedAt).getTime() ? new Date(store.lastSyncedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未同步' }}</small>
      </div>
    </aside>
    <main>
      <header>
        <div>
          <small>评估批次 2026-10-02 · 河湾片区</small>
          <h1>灾后需求评估与任务分派</h1>
          <p>回站续传采用“续作批次”：逐笔带编号、设备与基线，重放不生副本；字段冲突两版都保留，定案前不推进家庭状态。</p>
        </div>
        <div class="status-chip">
          <NProgress type="circle" :percentage="store.queue.length ? Math.max(12, 100 - store.queue.length * 12) : 100" :stroke-width="8" :width="42" />
          <span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '在途操作均已收下' }}</span>
        </div>
      </header>

      <section class="metrics">
        <NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard>
        <NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard>
        <NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard>
        <NCard><NStatistic label="本地未收队列" :value="store.metrics.queued" /></NCard>
      </section>

      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon style="margin-bottom:14px">
        当前链路不可用。记录、任务、合并都可离线操作并写入本地缓存与续作队列；恢复后只发送对端尚未收下的笔。
      </NAlert>

      <!-- ================= 需求记录 ================= -->
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false">
          <div class="households">
            <article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selected?.id === item.id }" @click="selectedId = item.id; startEdit()">
              <div>
                <b>{{ item.head }} · {{ item.members }}人 <small class="inline">来源 {{ item.origin === store.deviceLabel ? '本设备' : item.origin }}</small></b>
                <small>{{ item.community }} / {{ item.address }}</small>
                <p>{{ item.needs.join('、') }} · {{ item.note }}</p>
                <div class="tagline">
                  <NTag size="small" :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag>
                  <NTag size="small" :type="item.status === '已完成' ? 'success' : 'warning'">{{ item.status }}</NTag>
                  <NTag size="small" :type="item.ack ? 'default' : 'info'">{{ item.ack ? '对端已确认' : '本地未上送' }}</NTag>
                  <NTag v-for="c in store.openConflictFields(item.id)" :key="c.id" size="small" type="error">{{ fieldLabel(c.field) }}两版并存</NTag>
                  <small>rev{{ item.revision }} · 基线 {{ hashOf(item.base) }}</small>
                </div>
              </div>
            </article>
          </div>
        </NCard>
        <div class="side-stack">
          <NCard v-if="selected" :title="'断网补记：' + selected.head" size="small">
            <p class="hint">保存即写入续作队列并带当前基线；若对端也改过同一字段，合并时两版都会留下。</p>
            <label class="field"><span>地址描述</span><NInput v-model:value="editAddress" /></label>
            <label class="field"><span>现场说明</span><NInput v-model:value="editNote" type="textarea" /></label>
            <div class="actions" style="margin-top:8px">
              <NButton size="small" type="primary" @click="saveEdit">本地保存（入队）</NButton>
            </div>
            <div v-if="store.blockers(selected.id).length" class="blockers">
              <b>家庭状态暂不能定案：</b>
              <span v-for="(r, i) in store.blockers(selected.id)" :key="i">· {{ r }} </span>
            </div>
          </NCard>
          <NCard title="新增需求记录">
            <form class="field-grid" @submit.prevent="submit">
              <label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label>
              <label class="field"><span>社区</span><NInput v-model:value="community" /></label>
              <label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="楼栋与单元" /><small>{{ errors.address }}</small></label>
              <label class="field"><span>家庭人数</span><NInput v-model:value="members" type="number" /></label>
              <label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label>
              <label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label>
              <label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label>
              <div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div>
            </form>
          </NCard>
        </div>
      </div>

      <!-- ================= 重复合并 ================= -->
      <NCard v-if="panel === '重复合并'" title="疑似重复记录">
        <p class="hint">合并会把现场复核任务（含已完成）与待同步操作转到保留记录；对端也合并过的家庭，回传时以对端账本为准，不产生二次合并。</p>
        <div v-for="group in store.duplicates" :key="groupId(group)" class="duplicate">
          <b>{{ group[0].head }} · {{ group[0].community }} · {{ group.length }} 条</b>
          <div v-for="item in group" :key="item.id" class="dup-option" :class="{ chosen: keepOf(groupId(group), group[0].id) === item.id }">
            <label><input type="radio" :name="groupId(group)" :value="item.id" :checked="keepOf(groupId(group), group[0].id) === item.id" @change="keepChoice[groupId(group)] = item.id" /> 保留此条</label>
            <div>
              <small>{{ item.address }} · rev{{ item.revision }} · {{ item.ack ? '已上送' : '本地未上送' }} · 来源 {{ item.origin === store.deviceLabel ? '本设备' : item.origin }}</small>
              <p>{{ item.note }}</p>
              <small v-if="tasksOf(item.id).length" class="task-hint">关联任务：{{ tasksOf(item.id).map((t) => `${t.title}(${t.status})`).join('、') }} → 将转到保留记录</small>
            </div>
          </div>
          <NButton type="primary" size="small" @click="mergeGroup(group)">合并其余到保留记录（需求取并集）</NButton>
        </div>
        <p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p>
      </NCard>

      <!-- ================= 任务分派 ================= -->
      <div v-if="panel === '任务分派'" class="page-grid">
        <NCard title="任务列表">
          <div v-for="task in store.tasks" :key="task.id" class="task-row">
            <div>
              <b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b>
              <small>{{ store.households.find((item) => item.id === task.householdId)?.head }} · {{ task.assignee }} · {{ task.due }}</small>
              <small>创建设备 {{ task.createdBy ?? '未知' }} · {{ task.ack ? '对端已确认' : '本地未上送' }}</small>
            </div>
            <NTag :type="task.priority === '紧急' ? 'error' : 'default'">{{ task.priority }}</NTag>
            <span>{{ task.status }}</span>
            <NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton>
          </div>
          <p v-if="!store.tasks.length" class="empty">暂无任务。</p>
        </NCard>
        <NCard title="分派新任务">
          <p>当前家庭：<b>{{ selected?.head }}</b></p>
          <label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label>
          <label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label>
          <NButton type="primary" block style="margin-top:10px" :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton>
          <p class="hint" style="margin-top:10px">分派任务不会直接推进家庭状态；所有现场复核完成、冲突定案且重复记录处理后，家庭状态才会落定为“已完成”。</p>
        </NCard>
      </div>

      <!-- ================= 同步队列 ================= -->
      <NCard v-if="panel === '同步队列'" title="续作批次与待同步操作">
        <div class="sync-bar">
          <div>
            <NButton type="primary" :loading="store.syncing" :disabled="!store.online" @click="sync">发送续作批次</NButton>
            <label class="inject"><input type="checkbox" v-model="store.failNextBatch" /> 模拟弱网：下一批第 1 笔对端收不到</label>
          </div>
          <p class="sync-msg">{{ store.syncMessage || '恢复连接后按“未收下优先”续传；同一批次重发时，对端只回放第一次的结果。' }}</p>
        </div>

        <div v-if="store.queue.length" class="queue-list">
          <div v-for="item in store.queue" :key="item.id" class="queue-row" :class="{ inflight: item.lastBatchSeq !== undefined && item.lastBatchSeq < 0 }">
            <NTag :type="item.lastError ? 'warning' : 'default'">{{ kindLabel(item.kind) }}</NTag>
            <span>{{ item.entity }} · {{ item.detail }}</span>
            <small>设备 {{ store.deviceLabel }} · 基线 {{ item.kind === 'householdUpdate' && item.householdId ? hashOf(store.households.find((h) => h.id === item.householdId)?.base ?? {}) : '—' }}</small>
            <small v-if="item.attempts">已尝试 {{ item.attempts }} 次</small>
            <small v-if="item.lastError" class="err">未收下：{{ item.lastError }}</small>
          </div>
        </div>
        <p v-else class="empty">待同步队列为空——所有操作对端均已收下。</p>

        <div v-if="store.batchHistory.length" class="history">
          <b>批次台账（编号 / 设备 / 结果）</b>
          <div v-for="b in store.batchHistory" :key="b.batchSeq" class="history-row">
            <NTag size="small" :type="b.failed ? 'warning' : 'success'">#{{ b.batchSeq }}</NTag>
            <span>{{ b.deviceId }} · {{ new Date(b.sentAt).toLocaleTimeString('zh-CN') }} · {{ b.total }} 笔</span>
            <small>新收下 {{ b.accepted }} · 冲突 {{ b.conflicted }} · 未收下 {{ b.failed }}<template v-if="b.duplicate || b.replayHits"> · 重放命中 {{ b.replayHits }}（返回首次结果）</template></small>
            <small class="hist-summary">{{ b.summary }}</small>
          </div>
        </div>
      </NCard>

      <!-- ================= 冲突处理 ================= -->
      <NCard v-if="panel === '冲突处理'" title="字段级冲突（两边都改过 → 两版并存）">
        <p class="hint">只有对方动过的字段已在合并时自动接收；以下是两边都改过的字段，系统不静默覆盖，需人工定案。</p>
        <div v-for="item in store.conflicts" :key="item.id" class="conflict" :class="{ merged: item.status === '已合并' }">
          <b>{{ store.households.find((household) => household.id === item.householdId)?.head ?? '（已合并记录）' }} · {{ fieldLabel(item.field) }}</b>
          <div class="conflict-values">
            <div :class="{ picked: item.status === '采用本机' }"><small>本机「{{ item.localDevice }}」</small><span>{{ item.localValue }}</span></div>
            <div :class="{ picked: item.status === '采用对端' }"><small>对端「{{ item.remoteDevice }}」</small><span>{{ item.remoteValue }}</span></div>
          </div>
          <div class="actions">
            <NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本机')">采用本机（下批回传）</NButton>
            <NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用对端')">采用对端</NButton>
            <NButton size="small" type="warning" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '保留两版')">两版都保留</NButton>
            <NTag :type="item.status === '待处理' ? 'error' : item.status === '已合并' ? 'default' : 'success'">{{ item.status }}</NTag>
          </div>
          <small v-if="item.resolution" class="resolution">{{ item.resolution }}</small>
        </div>
        <p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先编辑本机记录后点击“发送续作批次”，与回站队部做一次三方合并。</p>
      </NCard>
    </main>
  </div>
</template>
