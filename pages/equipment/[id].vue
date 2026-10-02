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
import type { AcceptanceItem, ChainStatus, Certificate } from '../../types/domain'

const route = useRoute()
const store = useAcceptanceStore()
const toast = useToast()
const node = computed(() => store.equipment.find((item) => item.id === route.params.id))
const state = computed(() => (node.value ? store.nodeState(node.value.id) : undefined))
const branchPermit = computed(() => (node.value ? store.branchPermit(node.value.id) : null))
const effective = computed(() => (node.value ? store.effectivePermit(node.value.id) : null))
const firstChild = computed(() => state.value?.firstProblemChildId ? store.equipment.find((n) => n.id === state.value!.firstProblemChildId) : null)

const visible = ref(false)
const editable = reactive<Partial<AcceptanceItem>>({})
function openItem(item: AcceptanceItem) { Object.assign(editable, structuredClone(item)); visible.value = true }
function save() {
  if (!node.value || !editable.id) return
  const result = store.updateItem(node.value.id, editable.id, editable)
  toast.add({ severity: result.ok ? 'success' : 'warn', summary: result.ok ? '验收项已更新并逐级重算' : '写入失败已回滚', detail: result.message, life: 3200 })
  visible.value = false
}

const certVisible = ref(false)
const certEdit = reactive<Partial<Certificate> & { id?: string }>({})
function openCert(cert: Certificate) { Object.assign(certEdit, structuredClone(cert)); certVisible.value = true }
function saveCert() {
  if (!node.value || !certEdit.id) return
  const result = store.updateCertificate(node.value.id, certEdit.id, { verified: certEdit.verified, expiresAt: certEdit.expiresAt, name: certEdit.name })
  toast.add({ severity: result.ok ? 'success' : 'warn', summary: result.ok ? '证书已换版，上游放行立即失效' : '写入失败已回滚', detail: result.message, life: 3200 })
  certVisible.value = false
}
function confirmEdition(cert: Certificate) {
  if (!node.value) return
  const result = store.confirmCertificateEdition(node.value.id, cert.id)
  toast.add({ severity: result.ok ? 'success' : 'warn', summary: result.ok ? '新版证书已确认，换版依据解除' : '写入失败已回滚', detail: result.message, life: 3200 })
}

const chainTag: Record<ChainStatus, 'success' | 'danger' | 'warn' | 'info' | 'secondary'> = {
  无阻断: 'success', 正式放行: 'success', 阻断: 'danger', 临时放行: 'info', 放行失效: 'warn'
}
const siblings = computed(() => node.value ? store.equipment.filter((value) => value.parentId === node.value!.parentId || value.id === node.value!.id) : [])
</script>

<template>
  <section v-if="node" class="page">
    <div class="section-head">
      <div><span>{{ node.id }} · {{ node.code }}</span><h2>{{ node.name }}</h2><p>{{ node.type }} · 设备状态 {{ node.status }}</p></div>
      <div class="head-tags">
        <Tag v-if="state" :value="`放行链：${state.status}`" :severity="chainTag[state.status]" />
        <Tag v-if="effective && !branchPermit" value="继承上游分支放行" severity="info" icon="pi pi-link" />
        <Button label="放行链详情" severity="secondary" outlined @click="navigateTo('/release')" />
      </div>
    </div>

    <div v-if="state && state.status !== '无阻断' && state.status !== '正式放行'" class="chain-banner" :class="{ invalid: state.status === '放行失效' }">
      <i class="pi pi-exclamation-triangle" />
      <div>
        <p v-if="state.firstBlocker">
          最先问题来自 <strong>{{ firstChild?.name ?? node.name }}</strong>：
          {{ state.firstBlocker.title }}
          <Tag :value="state.firstBlocker.status" severity="contrast" style="margin:0 4px" />
          {{ state.firstBlocker.detail }}
        </p>
        <p v-if="branchPermit?.status === 'paused'" class="paused-note">
          分支放行单 {{ branchPermit.id }} 已失效：{{ branchPermit.invalidateReason }}
          <a @click="navigateTo('/release')">去重新确认 →</a>
        </p>
      </div>
    </div>

    <div class="equipment-path">
      <span v-for="item in siblings" :key="item.id" :class="{ active: item.id === node.id }" @click="navigateTo(`/equipment/${item.id}`)">{{ item.name }}</span>
    </div>
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
      <h3>证书与测试附件 <small>换版/核验变化将导致上游放行单立即失效并逐级重算</small></h3>
      <div v-for="certificate in node.certificates" :key="certificate.id" class="certificate-item cert-row">
        <Tag :value="certificate.verified ? '已核验' : '待核验'" :severity="certificate.verified ? 'success' : 'danger'" />
        <strong>{{ certificate.name }}</strong><span>{{ certificate.issuer }}</span><span>有效期至 {{ certificate.expiresAt }}</span><small>V{{ certificate.version }}</small>
        <Tag v-if="certificate.confirmedVersion !== undefined && certificate.confirmedVersion !== certificate.version" value="换版待确认" severity="warn" />
        <div class="cert-btns">
          <Button v-if="certificate.confirmedVersion !== undefined && certificate.confirmedVersion !== certificate.version" label="确认新版" size="small" severity="warn" @click="confirmEdition(certificate)" />
          <Button label="换版/核验" text size="small" @click="openCert(certificate)" />
        </div>
      </div>
      <p v-if="!node.certificates.length" class="cert-missing">当前设备节点暂无证书附件{{ ['汇流箱', '逆变器'].includes(node.type) ? '，该缺失构成链阻断依据' : '' }}。</p>
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
      <div class="edit-grid single">
        <label>证书名称<InputText v-model="certEdit.name" /></label>
        <label>有效期至<InputText v-model="certEdit.expiresAt" type="date" /></label>
        <label>核验状态<Select v-model="certEdit.verified" :options="[{ label: '已核验', value: true }, { label: '待核验', value: false }]" /></label>
        <p class="dialog-tip">保存后版本号递增；引用该证书的分支放行单将立即失效，需到放行链页面重新确认。</p>
      </div>
      <template #footer><Button label="取消" severity="secondary" text @click="certVisible = false" /><Button label="保存换版" @click="saveCert" /></template>
    </Dialog>
  </section>
  <section v-else class="page">未找到设备节点</section>
</template>
