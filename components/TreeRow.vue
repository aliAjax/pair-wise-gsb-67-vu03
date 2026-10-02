<script setup lang="ts">
import Tag from 'primevue/tag'
import type { ChainStatus, EquipmentNode, NodeChainState } from '../types/domain'

const props = defineProps<{
  nodes: EquipmentNode[]
  states: Map<string, NodeChainState>
  children: Map<string, EquipmentNode[]>
  nameById: Map<string, string>
  selectedId: string
  depth?: number
}>()

const emit = defineEmits<{ (e: 'select', id: string): void }>()

const severityMap: Record<ChainStatus, { severity: 'success' | 'danger' | 'warn' | 'info' | 'secondary'; icon: string }> = {
  无阻断: { severity: 'success', icon: 'pi pi-check-circle' },
  正式放行: { severity: 'success', icon: 'pi pi-verified' },
  阻断: { severity: 'danger', icon: 'pi pi-ban' },
  临时放行: { severity: 'info', icon: 'pi pi-clock' },
  放行失效: { severity: 'warn', icon: 'pi pi-exclamation-triangle' }
}

function state(id: string) { return props.states.get(id) }
function childList(id: string): EquipmentNode[] { return props.children.get(id) ?? [] }
</script>

<template>
  <template v-for="node in nodes" :key="node.id">
    <div class="tree-row" :class="{ selected: node.id === selectedId }" :style="{ paddingLeft: `${(depth ?? 0) * 22 + 10}px` }" @click="emit('select', node.id)">
      <i class="pi" :class="childList(node.id).length ? 'pi-folder-open' : 'pi-box'" />
      <strong>{{ node.name }}</strong>
      <small>{{ node.code }} · {{ node.type }}</small>
      <Tag v-if="state(node.id)" :value="state(node.id)!.status" :severity="severityMap[state(node.id)!.status].severity" :icon="severityMap[state(node.id)!.status].icon" />
      <span v-if="state(node.id)?.blockers.length" class="tree-count">
        {{ state(node.id)!.blockers.length }} 条依据
        <template v-if="state(node.id)!.firstProblemChildId">
          <em>· 最先出问题：{{ nameById.get(state(node.id)!.firstProblemChildId!) }}</em>
        </template>
      </span>
      <span v-if="state(node.id)?.permitId" class="tree-permit">
        <i class="pi pi-link" /> {{ state(node.id)!.permitRootId === node.id ? '本节点放行单' : `继承上游放行单` }}
      </span>
    </div>
    <TreeRow v-if="childList(node.id).length" :nodes="childList(node.id)" :states="states" :children="children" :name-by-id="nameById" :selected-id="selectedId" :depth="(depth ?? 0) + 1" @select="emit('select', $event)" />
  </template>
</template>
