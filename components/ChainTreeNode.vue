<script setup lang="ts">
import Tag from 'primevue/tag'
import Button from 'primevue/button'
import { computed, ref } from 'vue'
import { useAcceptanceStore } from '../stores/acceptance'
import type { ChainState, ReasonKind } from '../types/domain'
import type { ChainNodeResult } from '../services/chain'
const props = defineProps<{ nodeId: string }>()
const emit = defineEmits<{ apply: [nodeId: string] }>()
const store = useAcceptanceStore()
const expanded = ref(true)

const node = computed<ChainNodeResult | undefined>(() => store.chain.nodes[props.nodeId])
const stateMeta: Record<ChainState, { label: string; severity: 'success' | 'warn' | 'danger'; cls: string }> = {
  pass: { label: '具备条件', severity: 'success', cls: 'st-pass' },
  temp: { label: '临时放行', severity: 'warn', cls: 'st-temp' },
  block: { label: '阻断', severity: 'danger', cls: 'st-block' }
}
const kindColor: Record<ReasonKind, 'warn' | 'danger'> = { 验收项: 'warn', 证书: 'danger', 缺陷: 'danger' }

const pathText = computed(() => {
  const problem = node.value?.firstProblem
  if (!problem) return ''
  return problem.path.map((id) => store.chain.nodes[id]?.name ?? id).join(' › ')
})
const pass = computed(() => (node.value ? store.passAt(node.value.id) : undefined))
</script>

<template>
  <div v-if="node" class="chain-row-wrap">
    <div class="chain-row" :class="[stateMeta[node.effectiveState].cls, { 'is-first': node.firstProblem && node.firstProblem.nodeId === node.id && node.rawState !== 'pass' }]">
      <button class="chain-toggle" @click="expanded = !expanded">{{ node.childIds.length ? (expanded ? '▾' : '▸') : '·' }}</button>
      <div class="chain-main" :style="{ paddingLeft: `${node.depth * 22}px` }">
        <div class="chain-line1">
          <Tag :value="node.type" severity="secondary" />
          <strong>{{ node.name }}</strong>
          <small>{{ node.id }} · {{ node.code }}</small>
          <Tag :value="stateMeta[node.effectiveState].label" :severity="stateMeta[node.effectiveState].severity" />
          <Tag v-if="node.coveredByPassId && !pass" value="放行覆盖" severity="warn" />
          <Tag v-if="pass" :value="`本分支单：${pass.state}`" severity="info" />
          <span class="chain-spacer" />
          <Button v-if="!pass" label="申请分支放行" text size="small" @click="emit('apply', node.id)" />
          <template v-else>
            <Button v-if="pass.state === '待确认'" label="重新确认续期" size="small" @click="store.reconfirmPass(pass.id, '陆川')" />
            <Button label="撤销" text size="small" severity="danger" @click="store.closePass(pass.id, '陆川')" />
          </template>
        </div>
        <div class="chain-line2">
          <span class="chain-basis-count">本机依据：{{ node.reasons.length }}项异常</span>
          <template v-if="node.firstProblem">
            <span class="chain-first">最先出问题的子节点：<b>{{ node.firstProblem.nodeName }}</b></span>
            <span class="chain-path">{{ pathText }}</span>
            <Tag :value="node.firstProblem.reason.kind" :severity="kindColor[node.firstProblem.reason.kind]" />
            <span class="chain-evidence">{{ node.firstProblem.reason.title }} — {{ node.firstProblem.reason.detail }}（V{{ node.firstProblem.reason.version }}）</span>
          </template>
          <span v-else class="chain-ok">子树依据全部满足</span>
        </div>
        <div v-if="expanded" class="chain-detail">
          <p v-if="!node.reasons.length" class="chain-ok">本节点验收项、证书、缺陷均满足放行条件。</p>
          <div v-for="reason in node.reasons" :key="`${reason.kind}-${reason.sourceId}`" class="chain-reason" :class="`rs-${reason.state}`">
            <Tag :value="reason.kind" :severity="kindColor[reason.kind]" />
            <Tag :value="reason.state === 'block' ? '阻断' : '临时依据'" :severity="reason.state === 'block' ? 'danger' : 'warn'" />
            <strong>{{ reason.title }}</strong><span>{{ reason.detail }}</span><small>V{{ reason.version }}</small>
          </div>
          <div v-if="pass" class="chain-pass-box">
            <span>分支放行单 {{ pass.id }} · {{ pass.owner }} 签发 · {{ pass.issuedAt.replace('T', ' ').slice(0, 16) }}</span>
            <p>{{ pass.reason }}</p>
            <ul v-if="pass.changedSources?.length">
              <li v-for="change in pass.changedSources" :key="change.key">依据变化：{{ change.title }}（{{ change.before }} → {{ change.after }}）</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
    <template v-if="expanded">
      <ChainTreeNode v-for="childId in node.childIds" :key="childId" :node-id="childId" @apply="(id) => emit('apply', id)" />
    </template>
  </div>
</template>
