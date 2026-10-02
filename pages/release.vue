<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import TreeRow from '~/components/TreeRow.vue'
import { useAcceptanceStore } from '~/stores/acceptance'
import type { ChainStatus, ReleasePermit } from '~/types/domain'

const store = useAcceptanceStore()
const toast = useToast()
const selectedId = ref(store.equipment[0]?.id ?? '')

const nameById = computed(() => new Map(store.equipment.map((n) => [n.id, n.name])))
const selectedNode = computed(() => store.equipment.find((n) => n.id === selectedId.value))
const selectedState = computed(() => (selectedId.value ? store.nodeState(selectedId.value) : undefined))
const firstProblemChild = computed(() => selectedState.value?.firstProblemChildId ? store.equipment.find((n) => n.id === selectedState.value!.firstProblemChildId) : null)

/** 根 → 该节点链路上最先出问题的节点，用于页面顶部横幅 */
const rootState = computed(() => store.nodeState(store.tree.roots[0]?.id ?? ''))
const rootFirstBlocker = computed(() => rootState.value?.firstBlocker ?? null)
const rootFirstNode = computed(() => rootFirstBlocker.value ? store.equipment.find((n) => n.id === rootFirstBlocker.value!.equipmentId) : null)

const branchPermit = computed(() => (selectedId.value ? store.branchPermit(selectedId.value) : null))

const severityMap: Record<ChainStatus, { severity: 'success' | 'danger' | 'warn' | 'info' | 'secondary'; hint: string }> = {
  无阻断: { severity: 'success', hint: '本节点及子树依据齐全，链路畅通' },
  正式放行: { severity: 'success', hint: '依据齐全，正式放行' },
  阻断: { severity: 'danger', hint: '存在未覆盖的阻断依据，父级流程不得继续办理' },
  临时放行: { severity: 'info', hint: '已签发临时放行单，覆盖下列全部依据' },
  放行失效: { severity: 'warn', hint: '依据发生变化，临时放行已立即失效，须重新确认' }
}

// 申请放行
const applyVisible = ref(false)
const applyForm = reactive({ applicant: '', reason: '' })
function openApply() { applyForm.applicant = ''; applyForm.reason = ''; applyVisible.value = true }
function submitApply() {
  const result = store.applyPermit(selectedId.value, applyForm.applicant, applyForm.reason)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '临时放行已签发' : '申请被拒绝', detail: result.message, life: 3800 })
  if (result.ok) applyVisible.value = false
}

// 重新确认 / 撤销
const confirmVisible = ref(false)
const confirmNote = ref('')
const targetPermit = ref<ReleasePermit | null>(null)
function openReconfirm(permit: ReleasePermit) { targetPermit.value = permit; confirmNote.value = ''; confirmVisible.value = true }
function submitReconfirm() {
  if (!targetPermit.value) return
  const result = store.reconfirmPermit(targetPermit.value.id, '验收负责人陆川', confirmNote.value)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '放行继续有效' : '重新确认失败', detail: result.message, life: 3800 })
  if (result.ok) confirmVisible.value = false
}

const revokeVisible = ref(false)
const revokeReason = ref('')
function openRevoke(permit: ReleasePermit) { targetPermit.value = permit; revokeReason.value = ''; revokeVisible.value = true }
function submitRevoke() {
  if (!targetPermit.value) return
  const result = store.revokePermit(targetPermit.value.id, '验收负责人陆川', revokeReason.value)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '放行单已撤销' : '撤销失败', detail: result.message, life: 3200 })
  if (result.ok) revokeVisible.value = false
}

// 快照恢复
function restore(snapshotId: string) {
  const result = store.restoreSnapshot(snapshotId)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '已恢复完整树快照' : '恢复被拒绝', detail: result.message, life: 3800 })
}
function armFailure() {
  store.armFailure()
  toast.add({ severity: 'warn', summary: '已注入写入故障', detail: '下一次业务写入将在中途失败并从最后完整树快照恢复', life: 3200 })
}

const blockerTag: Record<string, 'danger' | 'warn' | 'info' | 'secondary'> = {
  不合格: 'danger', 重新打开: 'danger', 未核验: 'danger', 已过期: 'danger', 缺证书: 'danger', 换版待确认: 'danger',
  待复验: 'warn', 待检查: 'info'
}

function fmt(iso: string) { return iso ? iso.replace('T', ' ').slice(0, 16) : '—' }
</script>

<template>
  <section class="page release-page">
    <!-- 顶部：最先出问题的子节点与依据 -->
    <div class="root-banner" :class="rootState && rootState.status === '阻断' ? 'bad' : rootState?.status === '放行失效' ? 'warn' : 'good'">
      <i class="pi" :class="rootFirstBlocker ? 'pi-exclamation-triangle' : 'pi-check-circle'" />
      <div>
        <strong v-if="rootFirstBlocker">
          最先出问题的子节点：{{ rootFirstNode?.name }}（{{ rootFirstNode?.code }}）
          <Tag :value="rootFirstBlocker.kind" severity="contrast" style="margin:0 6px" />
          <Tag :value="rootFirstBlocker.status" :severity="blockerTag[rootFirstBlocker.status] ?? 'warn'" />
        </strong>
        <strong v-else>全链路依据齐全，并网放行畅通</strong>
        <p v-if="rootFirstBlocker">依据：{{ rootFirstBlocker.title }} — {{ rootFirstBlocker.detail }}</p>
        <p v-else>设备节点、验收项、证书、缺陷与分支放行单已组成树形放行链，上游变化逐级自动重算。</p>
      </div>
      <div class="banner-actions">
        <Button label="模拟写入故障" severity="secondary" outlined size="small" @click="armFailure" />
      </div>
    </div>

    <div class="release-layout">
      <!-- 左：树形放行链 -->
      <div class="tree-panel">
        <div class="panel-title"><h3>树形放行链</h3><small>点击节点查看依据与放行单</small></div>
        <div class="tree-body">
          <TreeRow :nodes="store.tree.roots" :states="store.chainStates" :children="store.tree.children" :name-by-id="nameById" :selected-id="selectedId" @select="selectedId = $event" />
        </div>
      </div>

      <!-- 右：节点链详情 -->
      <div class="detail-col" v-if="selectedNode && selectedState">
        <div class="node-head">
          <div>
            <span>{{ selectedNode.id }} · {{ selectedNode.code }} · {{ selectedNode.type }}</span>
            <h2>{{ selectedNode.name }}</h2>
            <p>{{ severityMap[selectedState.status].hint }}</p>
          </div>
          <Tag :value="selectedState.status" :severity="severityMap[selectedState.status].severity" style="transform:scale(1.15)" />
        </div>

        <!-- 最先问题指引 -->
        <div v-if="firstProblemChild" class="first-hint" @click="selectedId = selectedState.firstProblemChildId!">
          <i class="pi pi-arrow-down-right" />
          <div>
            <strong>最先出问题的直接子节点：{{ firstProblemChild.name }}</strong>
            <p>{{ selectedState.firstBlocker?.title }}（{{ selectedState.firstBlocker?.status }}）— {{ selectedState.firstBlocker?.detail }}</p>
          </div>
          <Button label="下钻" text size="small" />
        </div>
        <div v-else-if="selectedState.blockers.length && selectedState.ownBlockerCount === 0" class="first-hint self">
          <i class="pi pi-info-circle" />
          <div><strong>本节点依据均在子树</strong><p>阻断来源已在下方按“最先出问题”顺序列出。</p></div>
        </div>

        <!-- 本分支放行单 -->
        <div class="permit-card" v-if="branchPermit" :class="branchPermit.status">
          <div class="permit-head">
            <div>
              <span>分支临时放行单 {{ branchPermit.id }} · V{{ branchPermit.version }}</span>
              <h3>{{ branchPermit.branchRootName }} 分支</h3>
            </div>
            <Tag :value="branchPermit.status === 'active' ? '有效' : branchPermit.status === 'paused' ? '已失效待确认' : '已撤销'" :severity="branchPermit.status === 'active' ? 'info' : branchPermit.status === 'paused' ? 'warn' : 'secondary'" />
          </div>
          <div class="permit-grid">
            <div><small>申请人</small><strong>{{ branchPermit.applicant }}</strong></div>
            <div><small>签发时间</small><strong>{{ fmt(branchPermit.issuedAt) }}</strong></div>
            <div><small>最近重新确认</small><strong>{{ fmt(branchPermit.reconfirmedAt ?? '') }}</strong></div>
            <div class="span2"><small>放行事由</small><strong>{{ branchPermit.reason }}</strong></div>
          </div>
          <div v-if="branchPermit.status === 'paused'" class="permit-alert">
            <p v-if="branchPermit.invalidateReason"><i class="pi pi-bolt" /> {{ branchPermit.invalidateReason }}</p>
            <div v-if="branchPermit.basisAdded.length" class="basis-diff add">
              <small>新增/变化依据（证书换版、结果变化或缺陷重开）：</small>
              <ul><li v-for="(item, i) in branchPermit.basisAdded" :key="'a' + i">{{ item }}</li></ul>
            </div>
            <div v-if="branchPermit.basisRemoved.length" class="basis-diff remove">
              <small>已解除依据（子项问题已解决）：</small>
              <ul><li v-for="(item, i) in branchPermit.basisRemoved" :key="'r' + i">{{ item }}</li></ul>
            </div>
            <p class="reconfirm-tip">子项问题解决后在此重新确认，原先签发的临时放行才能继续。</p>
          </div>
          <div class="permit-actions">
            <Button v-if="branchPermit.status === 'paused'" label="重新确认，放行继续" size="small" @click="openReconfirm(branchPermit)" />
            <Button v-if="branchPermit.status !== 'revoked'" label="撤销" severity="danger" outlined size="small" @click="openRevoke(branchPermit)" />
          </div>
        </div>

        <!-- 操作 -->
        <div class="node-actions">
          <Button label="为该分支申请临时放行" icon="pi pi-file-import" size="small" :disabled="!selectedState.blockers.length || !!branchPermit" @click="openApply" />
          <Button label="打开设备与验收项" severity="secondary" outlined size="small" @click="navigateTo(`/equipment/${selectedNode.id}`)" />
          <Button label="查看缺陷" severity="secondary" outlined size="small" @click="navigateTo('/defects')" />
        </div>
        <p v-if="!selectedState.blockers.length && !branchPermit" class="clean-note">子树无阻断依据，无需临时放行。</p>

        <!-- 依据清单 -->
        <div class="blocker-list">
          <h3>链上阻断依据 <small>（本节点 {{ selectedState.ownBlockerCount }} 条 · 子树合并 {{ selectedState.blockers.length }} 条，按最先出问题排序）</small></h3>
          <DataTable :value="selectedState.blockers" dataKey="fingerprint" size="small">
            <Column header="类别" style="width:72px"><template #body="{ data }"><Tag :value="data.kind" severity="contrast" /></template></Column>
            <Column header="状态" style="width:96px"><template #body="{ data }"><Tag :value="data.status" :severity="blockerTag[data.status] ?? 'warn'" /></template></Column>
            <Column header="设备节点"><template #body="{ data }"><a class="link" @click="selectedId = data.equipmentId">{{ data.equipmentName }}</a></template></Column>
            <Column header="依据"><template #body="{ data }"><strong>{{ data.title }}</strong><p>{{ data.detail }}</p></template></Column>
            <Column header="严重度" style="width:70px"><template #body="{ data }"><Tag :value="data.severity" :severity="data.severity === '重大' ? 'danger' : 'secondary'" /></template></Column>
          </DataTable>
        </div>

        <!-- 快照与恢复 -->
        <div class="snapshot-panel">
          <div class="snap-head">
            <h3>完整树快照与恢复</h3>
            <small>每次变更前留存最后完整树；写入失败自动回滚，也可手动恢复</small>
          </div>
          <div v-for="note in store.recoveryNotes.slice(0, 3)" :key="note.at" class="recovery-note">
            <i class="pi pi-history" /> <span>{{ fmt(note.at) }}</span> {{ note.detail }}
          </div>
          <DataTable :value="store.snapshots" dataKey="id" size="small" :empty-message="'尚无快照，完成一次写入后生成'">
            <Column field="id" header="快照" style="width:170px" />
            <Column field="trigger" header="触发动作" />
            <Column field="operator" header="操作人" style="width:110px" />
            <Column header="时间" style="width:130px"><template #body="{ data }">{{ fmt(data.takenAt) }}</template></Column>
            <Column header="摘要" style="width:90px"><template #body="{ data }"><code>{{ data.digest }}</code></template></Column>
            <Column header="" style="width:90px"><template #body="{ data }"><Button label="恢复" text size="small" severity="warn" @click="restore(data.id)" /></template></Column>
          </DataTable>
        </div>
      </div>
    </div>

    <!-- 申请对话框 -->
    <Dialog v-model:visible="applyVisible" header="为分支申请临时放行" modal :style="{ width: '520px' }">
      <div class="edit-grid single">
        <label>负责人（申请人）<InputText v-model="applyForm.applicant" placeholder="如：验收负责人 陆川" /></label>
        <label>放行事由<Textarea v-model="applyForm.reason" :rows="4" placeholder="说明带条件临时放行的范围、期限与风险控制措施" /></label>
        <p class="dialog-tip">同一分支仅保留一张有效放行单；放行覆盖该节点整棵子树当前全部阻断依据，依据一旦变化立即失效。</p>
      </div>
      <template #footer><Button label="取消" text severity="secondary" @click="applyVisible = false" /><Button label="签发临时放行" @click="submitApply" /></template>
    </Dialog>

    <!-- 重新确认对话框 -->
    <Dialog v-model:visible="confirmVisible" header="重新确认临时放行" modal :style="{ width: '520px' }">
      <div class="edit-grid single">
        <label>确认说明<Textarea v-model="confirmNote" :rows="4" placeholder="核对新增/解除依据后的现状，确认放行继续" /></label>
        <p class="dialog-tip">确认后放行单按当前子树依据重新签发版本，原先的临时放行继续有效。</p>
      </div>
      <template #footer><Button label="取消" text severity="secondary" @click="confirmVisible = false" /><Button label="确认放行继续" @click="submitReconfirm" /></template>
    </Dialog>

    <!-- 撤销对话框 -->
    <Dialog v-model:visible="revokeVisible" header="撤销临时放行单" modal :style="{ width: '480px' }">
      <div class="edit-grid single"><label>撤销原因<Textarea v-model="revokeReason" :rows="3" /></label></div>
      <template #footer><Button label="取消" text severity="secondary" @click="revokeVisible = false" /><Button label="确认撤销" severity="danger" @click="submitRevoke" /></template>
    </Dialog>
  </section>
</template>
