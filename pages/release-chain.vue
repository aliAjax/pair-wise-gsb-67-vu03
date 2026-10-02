<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'

const store = useAcceptanceStore()
const toast = useToast()

const applyVisible = ref(false)
const applying = ref(false)
const form = reactive({ branchRootId: 'EQ-TR1', owner: '陆川', reason: '' })

const rootNodes = computed(() => store.chain.roots.map((id) => store.chain.nodes[id]))
const gridNode = computed(() => rootNodes.value.find((node) => node.type === '并网点') ?? rootNodes.value[0])
const firstProblemPath = computed(() => {
  const problem = gridNode.value?.firstProblem
  if (!problem) return []
  return problem.path.map((id) => store.chain.nodes[id])
})

function openApply(branchRootId?: string) {
  form.branchRootId = branchRootId ?? gridNode.value?.id ?? ''
  form.owner = '陆川'
  form.reason = ''
  applyVisible.value = true
}

function submitApply() {
  if (applying.value) return
  applying.value = true
  store.applyRelease(form.branchRootId, form.owner, form.reason, 300)
    .then((result) => {
      toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3200 })
      if (result.ok) applyVisible.value = false
    })
    .finally(() => { applying.value = false })
}

/** 两个负责人同时为同一分支申请放行：串行临界区下只保留一张有效单 */
async function simulateConcurrent() {
  if (applying.value) return
  applying.value = true
  const branchId = form.branchRootId || gridNode.value?.id
  if (!branchId) return
  const [r1, r2] = await Promise.all([
    store.applyRelease(branchId, '陆川', '负责人陆川窗口期申请', 500),
    store.applyRelease(branchId, '韩敏', '负责人韩敏窗口期申请', 500)
  ])
  toast.add({
    severity: r1.ok || r2.ok ? 'success' : 'warn',
    summary: '并发申请结束',
    detail: `陆川：${r1.message}；韩敏：${r2.message}`,
    life: 5000
  })
  applying.value = false
}

function runImportLegacy() {
  const result = store.importLegacyEquipment()
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3200 })
}
function runWriteFailure() {
  const result = store.simulateWriteFailure()
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 4200 })
}
function recover() {
  const result = store.recoverFromSnapshot()
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3200 })
}
function dismissRecovery() { store.recoveryNotice = '' }

function toastResult(result: { ok: boolean; message: string }) {
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3200 })
}

const passStateSeverity: Record<string, 'success' | 'warn' | 'info' | 'danger' | 'secondary'> = {
  临时放行中: 'warn',
  待确认: 'info',
  已续期: 'success',
  正式放行: 'success',
  已失效: 'danger'
}
const branchOptions = computed(() =>
  store.equipment.map((node) => ({ label: `${node.type} · ${node.name}`, value: node.id }))
)
</script>

<template>
  <section class="page release-page">
    <div v-if="store.recoveryNotice" class="recovery-banner">
      <i class="pi pi-info-circle" />
      <span>{{ store.recoveryNotice }}</span>
      <Button label="手动从最后快照恢复" text size="small" @click="recover" />
      <Button icon="pi pi-times" text size="small" @click="dismissRecovery" />
    </div>

    <div class="section-head">
      <div>
        <span>树版本 V{{ store.treeVersion }} · 最后完整快照 {{ store.lastSnapshotAt.replace('T', ' ').slice(0, 16) }}</span>
        <h2>树形放行链</h2>
        <p>设备节点 → 验收项 / 证书 / 缺陷 → 分支放行单逐级聚合；证书换版、结果变化或缺陷重开后上游立即失效并逐级重算。</p>
      </div>
      <div class="head-actions">
        <Button label="申请分支放行" icon="pi pi-send" @click="openApply()" />
        <Button label="两人同时申请演练" severity="secondary" outlined :loading="applying" @click="simulateConcurrent" />
        <Button label="导入缺父级旧数据" severity="secondary" outlined @click="runImportLegacy" />
        <Button label="写入中断演练" severity="danger" outlined @click="runWriteFailure" />
      </div>
    </div>

    <div v-if="gridNode?.firstProblem" class="first-problem-banner">
      <div class="fpb-title"><i class="pi pi-exclamation-triangle" /> 并网点当前最先出问题的子节点与依据</div>
      <div class="fpb-path">
        <template v-for="(item, index) in firstProblemPath" :key="item.id">
          <span :class="{ active: index === firstProblemPath.length - 1 }">{{ item.name }}</span>
          <i v-if="index < firstProblemPath.length - 1" class="pi pi-angle-right" />
        </template>
      </div>
      <div class="fpb-basis">
        <Tag :value="gridNode.firstProblem.reason.kind" severity="danger" />
        <strong>{{ gridNode.firstProblem.reason.title }}</strong>
        <span>{{ gridNode.firstProblem.reason.detail }}</span>
        <small>依据版本 V{{ gridNode.firstProblem.reason.version }}</small>
        <Tag v-if="gridNode.effectiveState === 'temp'" value="该路径由临时放行单覆盖，阻断并未真正消除" severity="warn" />
      </div>
    </div>
    <div v-else class="first-problem-banner all-pass">
      <i class="pi pi-check-circle" /> 并网点全树依据均满足，无阻断子节点。
    </div>

    <div class="chain-tree">
      <ChainTreeNode v-for="rootId in store.chain.roots" :key="rootId" :node-id="rootId" @apply="openApply" />
    </div>

    <div class="pass-grid">
      <div class="pass-list-panel">
        <h3>分支放行单（同一分支仅保留一张有效单）</h3>
        <div v-for="pass in store.passes" :key="pass.id" class="pass-card" :class="`pass-${pass.state}`">
          <div class="pass-card-head">
            <Tag :value="pass.state" :severity="passStateSeverity[pass.state]" />
            <strong>{{ pass.id }}</strong>
            <small>{{ pass.branchName }} · {{ pass.owner }}</small>
            <span class="chain-spacer" />
            <small>{{ pass.issuedAt.replace('T', ' ').slice(0, 16) }}</small>
          </div>
          <p>{{ pass.reason }}</p>
          <div v-if="pass.invalidBasis" class="pass-invalid">
            失效依据：{{ pass.invalidBasis.nodeName }} · {{ pass.invalidBasis.reason.title }}（{{ pass.invalidBasis.reason.detail }}）
          </div>
          <ul v-if="pass.changedSources?.length" class="pass-changes">
            <li v-for="change in pass.changedSources" :key="change.key">
              {{ change.title }}：{{ change.before }} → {{ change.after }}
            </li>
          </ul>
          <ol class="pass-history">
            <li v-for="(entry, idx) in pass.history" :key="idx">
              <small>{{ entry.at.replace('T', ' ').slice(0, 16) }} · {{ entry.operator }}</small>
              <span>{{ entry.action }}</span><em>{{ entry.detail }}</em>
            </li>
          </ol>
          <div v-if="pass.state === '待确认'" class="pass-actions">
            <span class="pass-hint">子项问题已解决，重新确认后原临时放行才能继续</span>
            <Button label="重新确认续期" size="small" @click="toastResult(store.reconfirmPass(pass.id, '陆川'))" />
          </div>
          <div v-else-if="pass.state !== '已失效'" class="pass-actions">
            <Button label="撤销放行" size="small" text severity="danger" @click="toastResult(store.closePass(pass.id, '陆川'))" />
          </div>
        </div>
      </div>
      <div class="repair-panel">
        <h3>旧数据父级关系补齐记录</h3>
        <p v-if="!store.repairNotes.length" class="muted">暂无修复记录。可点击「导入缺父级旧数据」演练：2号方阵与1-1-2汇流箱缺父级、1-2号逆变器父级悬空，将按现有层级自动补齐。</p>
        <div v-for="note in store.repairNotes" :key="`${note.nodeId}-${note.repairedAt}`" class="repair-item">
          <strong>{{ note.nodeName }}（{{ note.nodeId }}）</strong>
          <p>{{ note.reason }}</p>
          <small>父级：{{ note.oldParentId ?? '空' }} → {{ note.newParentId ?? '根' }}</small>
        </div>
      </div>
    </div>

    <Dialog v-model:visible="applyVisible" header="申请分支临时放行" modal :style="{ width: '560px' }">
      <div class="edit-grid">
        <label>分支根节点
          <Select v-model="form.branchRootId" :options="branchOptions" filter />
        </label>
        <label>负责人
          <InputText v-model="form.owner" />
        </label>
        <label class="full">临时放行事由（依据、风险与窗口期）
          <Textarea v-model="form.reason" rows="3" placeholder="如：缺陷整改+厂家复测窗口期，经建设单位同意临时放行上游主变及并网点流程" />
        </label>
      </div>
      <p class="apply-note">提交时记录分支子树全部验收项/证书/缺陷的版本指纹；任一依据换版或重新打开，该单立即失效并逐级重算。两位负责人同时申请时只有一张单生效。</p>
      <template #footer>
        <Button label="取消" text severity="secondary" @click="applyVisible = false" />
        <Button label="提交申请" :loading="applying" @click="submitApply" />
      </template>
    </Dialog>
  </section>
</template>
