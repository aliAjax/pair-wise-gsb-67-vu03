import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant } from '../data/seed'
import { diffBasis, recomputeChain, repairHierarchy } from '../services/chain'
import type {
  AcceptanceDefect, AcceptanceItem, AuditEntry, ChainBlocker, EquipmentNode,
  HierarchyRepair, NodeChainState, PartyReply, Plant, RecoveryNote, ReleasePermit, TreeSnapshot
} from '../types/domain'

const STORAGE_KEY = 'gsb67:grid-acceptance'
const SNAPSHOT_LIMIT = 10
let idSeed = 30
let snapshotSeed = 0

function nextId(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${idSeed++}` }

const isClient = () => import.meta.client || (globalThis as unknown as { __GSB_FORCE_CLIENT__?: boolean }).__GSB_FORCE_CLIENT__ === true

/** FNV-1a 摘要，用于校验快照完整性 */
function digest(payload: unknown): string {
  const text = JSON.stringify(payload)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
  return `0000000${(hash >>> 0).toString(16)}`.slice(-8)
}

function basisLabels(blockers: ChainBlocker[]) {
  return blockers.map((b) => `${b.equipmentName} · ${b.title}（${b.status}）`)
}

export const useAcceptanceStore = defineStore('acceptance', () => {
  // 种子数据先补齐旧父级关系，再进入链计算
  const seedRepair = repairHierarchy(structuredClone(seedEquipment))
  const plant = ref<Plant>(structuredClone(seedPlant))
  const equipment = ref<EquipmentNode[]>(seedRepair.nodes)
  const defects = ref<AcceptanceDefect[]>(structuredClone(seedDefects))
  const audit = ref<AuditEntry[]>(structuredClone(seedAudit))
  const permits = ref<ReleasePermit[]>([])
  const snapshots = ref<TreeSnapshot[]>([])
  const repairs = ref<HierarchyRepair[]>(seedRepair.repairs.map((r, i) => ({
    id: `RP-SEED-${i + 1}`, nodeId: r.nodeId, nodeName: equipment.value.find((n) => n.id === r.nodeId)?.name ?? r.nodeId,
    oldParentId: r.oldParentId, newParentId: r.newParentId, newParentName: r.newParentName, reason: r.reason, at: '2026-09-25T08:31:00'
  })))
  const recoveryNotes = ref<RecoveryNote[]>([])
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)
  /** 演示用：置位后下一次写入将在中途失败并回滚 */
  const failNextWrite = ref(false)

  // ===== 树形放行链：依据变化后整体自动重算 =====
  const chainStates = computed<Map<string, NodeChainState>>(() =>
    recomputeChain(equipment.value, defects.value, permits.value, plant.value))

  const selectedEquipment = computed(() => equipment.value.find((item) => item.id === selectedEquipmentId.value))
  const stats = computed(() => {
    const items = equipment.value.flatMap((item) => item.items)
    return {
      total: items.length,
      passed: items.filter((item) => item.status === '合格').length,
      failed: items.filter((item) => item.status === '不合格' || item.status === '待复验').length,
      openDefects: defects.value.filter((item) => !['已关闭', '带条件通过'].includes(item.status)).length,
      blockedNodes: [...chainStates.value.values()].filter((s) => s.status === '阻断' || s.status === '放行失效').length,
      activePermits: permits.value.filter((p) => p.status === 'active').length
    }
  })
  const preflight = computed(() => {
    const blocking: string[] = []
    const items = equipment.value.flatMap((item) => item.items)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')
    if (equipment.value.flatMap((item) => item.certificates).some((item) => !item.verified)) blocking.push('存在未核验证书')
    const expired = equipment.value.flatMap((item) => item.certificates).some((item) => item.expiresAt < plant.value.commissioningDate)
    if (expired) blocking.push('证书在并网日期前失效')
    return { allowed: blocking.length === 0, blocking }
  })

  // ===== 树工具 =====
  const tree = computed(() => {
    const byId = new Map(equipment.value.map((n) => [n.id, n]))
    const children = new Map<string, EquipmentNode[]>()
    const roots: EquipmentNode[] = []
    for (const node of equipment.value) {
      if (node.parentId && byId.has(node.parentId)) {
        const list = children.get(node.parentId) ?? []
        list.push(node)
        children.set(node.parentId, list)
      }
      else roots.push(node)
    }
    return { byId, children, roots }
  })

  function nodeState(id: string): NodeChainState | undefined { return chainStates.value.get(id) }

  /** 沿父链查找覆盖该节点的最近放行单（分支根在自身或任一祖先上） */
  function effectivePermit(id: string): ReleasePermit | null {
    let cur = tree.value.byId.get(id)
    let best: ReleasePermit | null = null
    while (cur) {
      const candidates = permits.value.filter((p) => p.branchRootId === cur!.id && p.status !== 'revoked')
      if (candidates.length) {
        candidates.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
        best = candidates[0]
        break
      }
      cur = cur.parentId ? tree.value.byId.get(cur.parentId) : undefined
    }
    return best
  }

  function branchPermit(branchRootId: string) {
    const list = permits.value.filter((p) => p.branchRootId === branchRootId && p.status !== 'revoked')
    list.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    return list[0] ?? null
  }

  // ===== 持久化与快照事务 =====
  function persistState(state: { plant: Plant; equipment: EquipmentNode[]; defects: AcceptanceDefect[]; audit: AuditEntry[]; permits: ReleasePermit[]; snapshots: TreeSnapshot[]; repairs: HierarchyRepair[]; recoveryNotes: RecoveryNote[] }) {
    if (!isClient()) return
    if (failNextWrite.value) { failNextWrite.value = false; throw new Error('SIMULATED_WRITE_FAILURE') }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, ...state }))
  }

  function persist() {
    persistState({ plant: plant.value, equipment: equipment.value, defects: defects.value, audit: audit.value, permits: permits.value, snapshots: snapshots.value, repairs: repairs.value, recoveryNotes: recoveryNotes.value })
  }

  function takeSnapshot(trigger: string, operator = '当前用户'): TreeSnapshot {
    const snap: TreeSnapshot = {
      id: `SNAP-${++snapshotSeed}-${Date.now().toString(36)}`,
      takenAt: new Date().toISOString(), trigger, operator,
      digest: digest({ plant: plant.value, equipment: equipment.value, defects: defects.value, permits: permits.value }),
      plant: structuredClone(plant.value),
      equipment: structuredClone(equipment.value),
      defects: structuredClone(defects.value),
      permits: structuredClone(permits.value)
    }
    snapshots.value.unshift(snap)
    if (snapshots.value.length > SNAPSHOT_LIMIT) snapshots.value.length = SNAPSHOT_LIMIT
    return snap
  }

  /**
   * 快照事务：先留存最后完整树快照，再执行写入；
   * 写入中途失败立即回滚到快照并按快照恢复持久化。
   */
  function commit(trigger: string, mutate: () => void, operator = '当前用户'): { ok: boolean; message: string } {
    const snap = takeSnapshot(trigger, operator)
    try {
      mutate()
      reconcilePermits()
      persist()
      return { ok: true, message: '已写入' }
    } catch (error) {
      plant.value = structuredClone(snap.plant)
      equipment.value = structuredClone(snap.equipment)
      defects.value = structuredClone(snap.defects)
      permits.value = structuredClone(snap.permits)
      // 回滚本身必须落盘：失败标记已被消费，直接持久化最后完整树
      try { persist() } catch { /* localStorage 不可用时仅保留内存恢复结果 */ }
      recoveryNotes.value.unshift({ at: new Date().toISOString(), snapshotId: snap.id, trigger, detail: `“${trigger}”写入中途失败（${(error as Error).message}），已从最后完整树快照 ${snap.id} 恢复` })
      audit.value.unshift({ id: nextId('AUD'), entityId: snap.id, action: '快照恢复', operator: '系统', detail: `写入失败，按快照${snap.id}回滚「${trigger}」`, createdAt: new Date().toISOString() })
      return { ok: false, message: `写入中途失败，已从快照 ${snap.id} 恢复` }
    }
  }

  /** 依据变化后比对每张放行单：依据增删（换版/结果变化/缺陷重开/问题解除）立即失效，须重新确认 */
  function reconcilePermits() {
    const now = new Date().toISOString()
    for (const permit of permits.value) {
      if (permit.status === 'revoked') continue
      const state = chainStates.value.get(permit.branchRootId)
      if (!state) {
        if (permit.status === 'active') { permit.status = 'paused'; permit.invalidatedAt = now; permit.invalidateReason = '分支根节点缺失，放行链无法重算' }
        continue
      }
      const { added, removed } = diffBasis(permit, state)
      permit.basisAdded = added
      permit.basisRemoved = removed
      if (permit.status === 'active' && (added.length || removed.length)) {
        permit.status = 'paused'
        permit.invalidatedAt = now
        permit.invalidateReason = added.length
          ? `上游依据发生变化，最先问题：${added[0]}`
          : `问题子项已解除：${removed[0]}，需重新确认后放行单方可继续`
        audit.value.unshift({ id: nextId('AUD'), entityId: permit.id, action: '放行单失效', operator: '系统', detail: permit.invalidateReason, createdAt: now })
      }
    }
  }

  function hydrate() {
    if (!isClient() || hydrated.value) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const stored = JSON.parse(raw)
        plant.value = stored.plant
        equipment.value = stored.equipment
        defects.value = stored.defects
        audit.value = stored.audit
        permits.value = stored.permits ?? []
        snapshots.value = stored.snapshots ?? []
        repairs.value = stored.repairs ?? []
        recoveryNotes.value = stored.recoveryNotes ?? []
        // 旧数据缺少父级关系：补齐层级后再参与计算
        const repair = repairHierarchy(equipment.value)
        if (repair.repairs.length) {
          equipment.value = repair.nodes
          for (const r of repair.repairs) {
            repairs.value.unshift({
              id: nextId('RP'), nodeId: r.nodeId, nodeName: equipment.value.find((n) => n.id === r.nodeId)?.name ?? r.nodeId,
              oldParentId: r.oldParentId, newParentId: r.newParentId, newParentName: r.newParentName, reason: r.reason, at: new Date().toISOString()
            })
            audit.value.unshift({ id: nextId('AUD'), entityId: r.nodeId, action: '补齐父级关系', operator: '系统', detail: `${r.reason}，挂接至${r.newParentName}`, createdAt: new Date().toISOString() })
          }
        }
      }
    } catch {
      // 存储损坏时保留种子数据
    }
    hydrated.value = true
    persist()
  }

  // ===== 验收项与证书 =====
  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>) {
    return commit('验收项结果变化', () => {
      const item = equipment.value.find((node) => node.id === equipmentId)?.items.find((value) => value.id === itemId)
      if (!item) return
      Object.assign(item, patch, { version: item.version + 1 })
      log(equipmentId, '更新验收项', '当前用户', `${item.standard}结果更新为${item.status}（V${item.version}）`)
    })
  }

  /** 证书换版：版本号递增，已确认版次停留旧值，链上立即出现“换版待确认”依据 */
  function updateCertificate(equipmentId: string, certificateId: string, patch: Partial<{ verified: boolean; expiresAt: string; name: string }>) {
    return commit('证书换版', () => {
      const node = equipment.value.find((n) => n.id === equipmentId)
      const cert = node?.certificates.find((c) => c.id === certificateId)
      if (!node || !cert) return
      const confirmed = cert.confirmedVersion ?? cert.version
      Object.assign(cert, patch, { version: cert.version + 1, confirmedVersion: confirmed })
      log(equipmentId, '证书换版', '当前用户', `${cert.name}换版至V${cert.version}（已确认V${confirmed}，有效期至${cert.expiresAt}），上游放行立即失效`)
    })
  }

  /** 确认新版证书：已确认版次对齐当前版本，“换版待确认”依据解除 */
  function confirmCertificateEdition(equipmentId: string, certificateId: string) {
    return commit('确认证书新版', () => {
      const node = equipment.value.find((n) => n.id === equipmentId)
      const cert = node?.certificates.find((c) => c.id === certificateId)
      if (!node || !cert) return
      cert.confirmedVersion = cert.version
      cert.verified = true
      log(equipmentId, '确认证书新版', '当前用户', `${cert.name} V${cert.version} 已确认，换版待确认依据解除`)
    })
  }

  // ===== 缺陷 =====
  function assignDefect(id: string, owner: string) {
    return commit('分派缺陷', () => {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) return
      defect.owner = owner
      defect.status = '整改中'
      defect.version += 1
      log(id, '分派缺陷', '验收负责人', `责任方调整为${owner}`)
    })
  }

  function addReply(id: string, reply: PartyReply) {
    if (!reply.content || !reply.evidence) return { ok: false, message: '回复内容和证据均不能为空' }
    return commit('提交多方处理说明', () => {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) return
      defect.replies.unshift({ ...reply, repliedAt: reply.repliedAt || new Date().toISOString() })
      defect.status = '待联合复验'
      defect.version += 1
      log(id, `${reply.party}提交处理说明`, reply.owner, reply.content)
    }, reply.owner)
  }

  function addRetest(id: string, result: string, passed: boolean) {
    return commit('联合复验', () => {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) return
      defect.retests.unshift({ round: defect.retests.length + 1, passed, result, tester: '联合验收组', testedAt: new Date().toISOString() })
      defect.status = passed ? '已关闭' : '整改中'
      defect.version += 1
      log(id, '执行联合复验', '联合验收组', result)
    }, '联合验收组')
  }

  function decideDefect(id: string, status: '已关闭' | '带条件通过' | '整改中', note: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (status === '已关闭' && !defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复验记录，不能关闭' }
    if (status === '带条件通过' && !note.trim()) return { ok: false, message: '带条件通过必须说明限制条件' }
    return commit('验收决定', () => {
      defect.status = status
      defect.decisionNote = note
      defect.version += 1
      log(id, `验收决定：${status}`, '验收负责人', note || '完成整改闭环')
    }, '验收负责人')
  }

  /** 缺陷重新打开：关联验收项重新成为阻断依据，上游放行逐级失效 */
  function reopenDefect(id: string, note: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (!['已关闭', '带条件通过'].includes(defect.status)) return { ok: false, message: '仅已关闭或带条件通过的缺陷可重新打开' }
    if (!note.trim()) return { ok: false, message: '重新打开必须说明原因' }
    return commit('缺陷重新打开', () => {
      defect.status = '重新打开'
      defect.decisionNote = note
      defect.version += 1
      log(id, '缺陷重新打开', '验收负责人', note)
    }, '验收负责人')
  }

  // ===== 分支放行单 =====
  function applyPermit(branchRootId: string, applicant: string, reason: string) {
    if (!applicant.trim() || !reason.trim()) return { ok: false, message: '申请人和放行事由均不能为空' }
    const state = chainStates.value.get(branchRootId)
    if (!state) return { ok: false, message: '分支节点不存在' }
    const existing = branchPermit(branchRootId)
    if (existing) {
      return existing.status === 'active'
        ? { ok: false, message: `该分支已存在有效放行单 ${existing.id}（${existing.applicant}），同分支只保留一张有效单` }
        : { ok: false, message: `该分支放行单 ${existing.id} 已失效，须先重新确认或撤销，不能重复申请` }
    }
    if (!state.blockers.length) return { ok: false, message: '该分支子树无阻断依据，无需临时放行' }
    return commit('申请分支临时放行', () => {
      const node = tree.value.byId.get(branchRootId)!
      const permit: ReleasePermit = {
        id: nextId('RP'), branchRootId, branchRootName: node.name,
        applicant: applicant.trim(), reason: reason.trim(), kind: 'temporary', status: 'active',
        basis: { fingerprints: state.blockers.map((b) => b.fingerprint), labels: basisLabels(state.blockers) },
        issuedAt: new Date().toISOString(), reconfirmedAt: null,
        invalidatedAt: null, invalidateReason: '', basisAdded: [], basisRemoved: [], revokedAt: null, version: 1
      }
      permits.value.unshift(permit)
      log(permit.id, '签发分支临时放行', applicant, `分支「${node.name}」带 ${state.blockers.length} 条依据临时放行，覆盖整棵子树`)
    }, applicant)
  }

  /** 子项问题解决/依据变化后重新确认，原放行单按当前依据继续有效 */
  function reconfirmPermit(permitId: string, operator: string, note: string) {
    const permit = permits.value.find((p) => p.id === permitId)
    if (!permit) return { ok: false, message: '放行单不存在' }
    if (permit.status === 'revoked') return { ok: false, message: '放行单已撤销' }
    if (permit.status === 'active') return { ok: false, message: '放行单仍有效，无需重新确认' }
    const state = chainStates.value.get(permit.branchRootId)
    if (!state) return { ok: false, message: '分支节点缺失，无法确认' }
    return commit('重新确认临时放行', () => {
      permit.status = 'active'
      permit.reconfirmedAt = new Date().toISOString()
      permit.invalidatedAt = null
      permit.invalidateReason = ''
      permit.basisAdded = []
      permit.basisRemoved = []
      permit.version += 1
      permit.basis = { fingerprints: state.blockers.map((b) => b.fingerprint), labels: basisLabels(state.blockers) }
      log(permit.id, '重新确认临时放行', operator || '验收负责人', note || `按当前 ${state.blockers.length} 条依据重新确认，放行继续`)
    }, operator || '验收负责人')
  }

  function revokePermit(permitId: string, operator: string, reason: string) {
    const permit = permits.value.find((p) => p.id === permitId)
    if (!permit || permit.status === 'revoked') return { ok: false, message: '放行单不存在或已撤销' }
    if (!reason.trim()) return { ok: false, message: '撤销必须说明原因' }
    return commit('撤销临时放行', () => {
      permit.status = 'revoked'
      permit.revokedAt = new Date().toISOString()
      permit.invalidateReason = reason
      permit.version += 1
      log(permit.id, '撤销临时放行', operator || '验收负责人', reason)
    }, operator || '验收负责人')
  }

  // ===== 快照恢复 =====
  function restoreSnapshot(snapshotId: string) {
    const snap = snapshots.value.find((s) => s.id === snapshotId)
    if (!snap) return { ok: false, message: '快照不存在' }
    if (digest({ plant: snap.plant, equipment: snap.equipment, defects: snap.defects, permits: snap.permits }) !== snap.digest) {
      return { ok: false, message: '快照摘要校验失败，拒绝恢复' }
    }
    // 先留存当前完整树，保证恢复可逆向
    return commit(`恢复快照 ${snap.id}`, () => {
      plant.value = structuredClone(snap.plant)
      equipment.value = structuredClone(snap.equipment)
      defects.value = structuredClone(snap.defects)
      permits.value = structuredClone(snap.permits)
      recoveryNotes.value.unshift({ at: new Date().toISOString(), snapshotId: snap.id, trigger: snap.trigger, detail: `人工恢复至快照 ${snap.id}（原始动作：${snap.trigger}）` })
      log(snap.id, '人工恢复树快照', '验收负责人', `恢复到 ${snap.takenAt.replace('T', ' ').slice(0, 16)} 的完整树`)
    }, '验收负责人')
  }

  function armFailure() { failNextWrite.value = true }

  function signOff() {
    if (!preflight.value.allowed) return { ok: false, message: preflight.value.blocking.join('；') }
    return commit('签署交付版本', () => {
      plant.value.status = '已签署'
      plant.value.version += 1
      equipment.value.forEach((node) => { node.status = '已验收' })
      log(plant.value.id, '签署交付版本', '验收负责人陆川', `锁定V${plant.value.version}并生成交付包`)
    }, '验收负责人陆川')
  }

  function reset() {
    const repaired = repairHierarchy(structuredClone(seedEquipment))
    plant.value = structuredClone(seedPlant)
    equipment.value = repaired.nodes
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    permits.value = []
    snapshots.value = []
    recoveryNotes.value = []
    repairs.value = repaired.repairs.map((r, i) => ({
      id: `RP-SEED-${i + 1}`, nodeId: r.nodeId, nodeName: equipment.value.find((n) => n.id === r.nodeId)?.name ?? r.nodeId,
      oldParentId: r.oldParentId, newParentId: r.newParentId, newParentName: r.newParentName, reason: r.reason, at: '2026-09-25T08:31:00'
    }))
    persist()
  }

  function log(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: nextId('AUD'), entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  return {
    plant, equipment, defects, audit, permits, snapshots, repairs, recoveryNotes,
    selectedEquipmentId, keyword, hydrated, failNextWrite,
    selectedEquipment, stats, preflight, chainStates, tree,
    hydrate, nodeState, effectivePermit, branchPermit,
    updateItem, updateCertificate, confirmCertificateEdition, assignDefect, addReply, addRetest, decideDefect, reopenDefect,
    applyPermit, reconfirmPermit, revokePermit, restoreSnapshot, armFailure,
    takeSnapshot, signOff, reset, log
  }
})
