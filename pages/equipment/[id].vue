<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../../stores/acceptance'
import type { AcceptanceItem, Certificate } from '../../types/domain'

const route = useRoute()
const store = useAcceptanceStore()
const toast = useToast()
const node = computed(() => store.equipment.find((item) => item.id === route.params.id as string))
const chainNode = computed(() => (node.value ? store.chain.nodes[node.value.id] : undefined))
const visible = ref(false)
const editable = reactive<Partial<AcceptanceItem>>({})
const certVisible = ref(false)
const certForm = reactive<{ id?: string; issuer?: string; expiresAt?: string; version: string; verified: boolean }>({ version: '1', verified: true })
const reopenTarget = ref<string | null>(null)
const reopenNote = ref('')

const stateTag = { pass: { v: '具备条件', s: 'success' as const }, temp: { v: '临时放行', s: 'warn' as const }, block: { v: '阻断', s: 'danger' as const } }

function openItem(item: AcceptanceItem) { Object.assign(editable, JSON.parse(JSON.stringify(item))); visible.value = true }
function save() {
  if (!node.value || !editable.id) return
  const result = store.updateItem(node.value.id, editable.id, editable)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 2800 })
  if (result.ok) visible.value = false
}
function openCert(cert: Certificate) {
  Object.assign(certForm, { id: cert.id, issuer: cert.issuer, expiresAt: cert.expiresAt, version: String(cert.version), verified: cert.verified })
  certVisible.value = true
}
function saveCert() {
  if (!node.value || !certForm.id) return
  const patch = {
    issuer: certForm.issuer,
    expiresAt: certForm.expiresAt,
    version: Number(certForm.version),
    verified: certForm.verified
  }
  const result = store.updateCertificate(node.value.id, certForm.id, patch)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 2800 })
  if (result.ok) certVisible.value = false
}
function confirmReopen(id: string) {
  const result = store.reopenDefect(id, reopenNote.value)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3200 })
  if (result.ok) { reopenTarget.value = null; reopenNote.value = '' }
}
const nodeDefects = computed(() => node.value ? store.defects.filter((defect) => defect.equipmentId === node.value!.id) : [])
</script>

<template>
  <section v-if="node && chainNode" class="page">
    <div class="section-head">
      <div><span>{{ node.id }} · {{ node.code }}</span><h2>{{ node.name }}</h2><p>{{ node.type }} · 放行链状态 <b>{{ stateTag[chainNode.effectiveState].v }}</b></p></div>
      <div class="node-head-tags">
        <Tag :value="stateTag[chainNode.subtreeState].v" :severity="stateTag[chainNode.subtreeState].s" />
        <Tag v-if="chainNode.coveredByPassId" value="有放行单覆盖" severity="warn" />
        <Button label="为本分支申请放行" outlined @click="navigateTo('/release-chain')" />
      </div>
    </div>

    <div v-if="chainNode.firstProblem" class="node-first-problem">
      <i class="pi pi-exclamation-triangle" />
      <span>子树最先出问题：<b>{{ chainNode.firstProblem.nodeName }}</b></span>
      <Tag :value="chainNode.firstProblem.reason.kind" severity="danger" />
      <span>{{ chainNode.firstProblem.reason.title }} — {{ chainNode.firstProblem.reason.detail }}（V{{ chainNode.firstProblem.reason.version }}）</span>
    </div>

    <div class="equipment-path"><span v-for="item in store.equipment.filter((value) => value.parentId === node?.parentId || value.id === node?.id)" :key="item.id" :class="{ active: item.id === node.id }" @click="navigateTo(`/equipment/${item.id}`)">{{ item.name }}</span></div>
    <DataTable :value="node.items" dataKey="id" size="small">
      <Column field="id" header="编号" style="width:100px" />
      <Column field="standard" header="验收标准" />
      <Column field="method" header="测试方法" />
      <Column field="condition" header="测试条件" />
      <Column field="measured" header="实测结果" />
      <Column field="evidence" header="测试证据" />
      <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="data.status === '合格' ? 'success' : data.status === '不合格' ? 'danger' : 'warn'" /></template></Column>
      <Column header="版本"><template #body="{ data }">V{{ data.version }}</template></Column>
      <Column header=""><template #body="{ data }"><Button label="录入/复核" text @click="openItem(data)" /></template></Column>
    </DataTable>
    <div class="certificate-panel">
      <h3>证书与测试附件（换版后立即触发逐级重算）</h3>
      <div v-for="certificate in node.certificates" :key="certificate.id" class="certificate-item cert-item-grid">
        <Tag :value="certificate.verified ? '已核验' : '待核验/缺失'" :severity="certificate.verified ? 'success' : 'danger'" />
        <strong>{{ certificate.name }}</strong><span>{{ certificate.issuer }}</span><span>有效期至 {{ certificate.expiresAt }}</span><small>V{{ certificate.version }}</small>
        <Button label="换版/核验" text size="small" @click="openCert(certificate)" />
      </div>
      <p v-if="!node.certificates.length">当前设备节点暂无证书附件。</p>
    </div>

    <div v-if="nodeDefects.length" class="certificate-panel">
      <h3>关联缺陷（已闭环缺陷重新打开后，上游放行单立即失效）</h3>
      <div v-for="defect in nodeDefects" :key="defect.id" class="defect-line">
        <Tag :value="defect.severity" :severity="defect.severity === '重大' ? 'danger' : 'warn'" />
        <Tag :value="defect.status" :severity="['已关闭', '带条件通过'].includes(defect.status) ? 'success' : 'warn'" />
        <strong>{{ defect.title }}</strong><small>V{{ defect.version }}</small>
        <span class="chain-spacer" />
        <Button v-if="reopenTarget !== defect.id && ['已关闭', '带条件通过'].includes(defect.status)" label="缺陷重新打开" text size="small" severity="danger" @click="reopenTarget = defect.id" />
        <template v-else-if="reopenTarget === defect.id">
          <InputText v-model="reopenNote" placeholder="重新打开原因（复测异常/问题回归）" style="min-width:260px" />
          <Button label="确认重开" size="small" severity="danger" @click="confirmReopen(defect.id)" />
          <Button label="取消" text size="small" @click="reopenTarget = null; reopenNote = ''" />
        </template>
      </div>
    </div>

    <Dialog v-model:visible="visible" header="录入验收项" modal :style="{ width: '620px' }">
      <div class="edit-grid">
        <label>状态<Select v-model="editable.status" :options="['待检查', '合格', '不合格', '待复验']" /></label>
        <label>实测结果<InputText v-model="editable.measured" /></label>
        <label>测试证据<InputText v-model="editable.evidence" /></label>
        <label>测试条件<Textarea v-model="editable.condition" rows="3" /></label>
      </div>
      <template #footer><Button label="取消" severity="secondary" text @click="visible = false" /><Button label="保存并递增版本" @click="save" /></template>
    </Dialog>
    <Dialog v-model:visible="certVisible" header="证书换版 / 核验" modal :style="{ width: '520px' }">
      <div class="edit-grid">
        <label>签发机构<InputText v-model="certForm.issuer" /></label>
        <label>有效期至<InputText v-model="certForm.expiresAt" type="date" /></label>
        <label>版本号<InputText v-model="certForm.version" type="number" min="1" /></label>
        <label>核验状态<Select v-model="certForm.verified" :options="[{ label: '已核验', value: true }, { label: '缺失/未核验', value: false }]" /></label>
      </div>
      <template #footer><Button label="取消" severity="secondary" text @click="certVisible = false" /><Button label="保存并触发重算" @click="saveCert" /></template>
    </Dialog>
  </section>
  <section v-else class="page">未找到设备节点</section>
</template>
