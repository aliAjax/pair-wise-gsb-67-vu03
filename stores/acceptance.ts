import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant } from '../data/seed'
import {
  ancestorsOf,
  buildSignatures,
  evaluateTree,
  isPassActive,
  recomputePasses,
  repairHierarchy
} from '../services/chain'
import type {
  AcceptanceDefect,
  AcceptanceItem,
  AuditEntry,
  Certificate,
  ChangedSource,
  EquipmentNode,
  PartyReply,
  Plant,
  ReleasePass,
  RepairNote
} from '../types/domain'

const STORAGE_KEY = 'gsb67:release-chain:v1'
const LEGACY_STORAGE_KEY = 'gsb67:grid-acceptance'
const TMP_KEY = `${STORAGE_KEY}:tmp`
let auditSeq = 100
let passSeq = 0

interface Snapshot {
  plant: Plant
  equipment: EquipmentNode[]
  defects: AcceptanceDefect[]
  audit: AuditEntry[]
  passes: ReleasePass[]
  repairNotes: RepairNote[]
  treeVersion: number
  savedAt: string
}

interface Draft {
  plant: Plant
  equipment: EquipmentNode[]
  defects: AcceptanceDefect[]
  audit: AuditEntry[]
  passes: ReleasePass[]
  repairNotes: RepairNote[]
}

interface CommitResult {
  ok: boolean
  message: string
  recovered?: boolean
  restoredVersion?: number
}

const now = () => new Date().toISOString()

/**
 * 深克隆：提交事务时源数据是 Pinia/Vue 的响应式代理，structuredClone 无法克隆 Proxy，
 * 而本域数据（节点/验收项/证书/缺陷/放行单）均可 JSON 序列化，故统一走 JSON。
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pushAudit(draft: Draft, entityId: string, action: string, operator: string, detail: string) {
  draft.audit.unshift({ id: `AUD-${Date.now()}-${auditSeq++}`, entityId, action, operator, detail, createdAt: now() })
}

/** 取分支根子树（含根）全部指纹 */
function subtreeSignatures(rootId: string, equipment: EquipmentNode[], defects: AcceptanceDefect[], commissioningDate: string) {
  const tree = evaluateTree(equipment, defects, commissioningDate, [])
  const ids = new Set<string>()
  const walk = (id: string) => {
    const node = tree.nodes[id]
    if (!node) return
    ids.add(id)
    node.childIds.forEach(walk)
  }
  walk(rootId)
  const all = buildSignatures(equipment, defects, commissioningDate)
  const picked: Record<string, string> = {}
  ids.forEach((id) => {
    Object.entries(tree.nodes[id]?.signatures ?? {}).forEach(([key, value]) => { picked[key] = value })
  })
  void all
  return picked
}

/** 初始内置临时放行单：主变分支整改期间临时放行，证书换版/复测变化即失效 */
function seedPasses(equipment: EquipmentNode[], defects: AcceptanceDefect[], commissioningDate: string): ReleasePass[] {
  const signatures = subtreeSignatures('EQ-TR1', equipment, defects, commissioningDate)
  return [{
    id: 'RP-SEED-01',
    branchRootId: 'EQ-TR1',
    branchName: '1号主变压器',
    owner: '陆川',
    reason: '有载调压档位缺陷整改与厂家复测期间，经建设单位同意临时放行主变及并网点上游流程',
    issuedAt: '2026-09-29T18:00:00',
    state: '临时放行中',
    signatures,
    treeVersion: 1,
    history: [{ at: '2026-09-29T18:00:00', action: '签发临时放行', operator: '陆川', detail: '仅限整改窗口期，依据换版或复测变化立即失效' }]
  }]
}

function freshState(): Snapshot {
  const equipment = clone(seedEquipment)
  const defects = clone(seedDefects)
  const plant = clone(seedPlant)
  return {
    plant,
    equipment,
    defects,
    audit: clone(seedAudit),
    passes: seedPasses(equipment, defects, plant.commissioningDate),
    repairNotes: [],
    treeVersion: 1,
    savedAt: now()
  }
}

function isValidSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<Snapshot>
  return Array.isArray(snapshot.equipment) && Array.isArray(snapshot.defects)
    && Array.isArray(snapshot.audit) && Array.isArray(snapshot.passes)
    && !!snapshot.plant && typeof snapshot.treeVersion === 'number'
}

export const useAcceptanceStore = defineStore('acceptance', () => {
  const initial = freshState()
  const plant = ref<Plant>(initial.plant)
  const equipment = ref<EquipmentNode[]>(initial.equipment)
  const defects = ref<AcceptanceDefect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const passes = ref<ReleasePass[]>(initial.passes)
  const repairNotes = ref<RepairNote[]>(initial.repairNotes)
  const treeVersion = ref(initial.treeVersion)
  const lastSnapshotAt = ref(initial.savedAt)
  const recoveryNotice = ref('')
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)
  let forceNextFailure = false

  /* ---------- 树形放行链：设备节点 → 验收项/证书/缺陷 → 分支放行单 ---------- */

  const activePasses = computed(() => passes.value.filter(isPassActive))
  const chain = computed(() => evaluateTree(equipment.value, defects.value, plant.value.commissioningDate, activePasses.value))
  const signatures = computed(() => buildSignatures(equipment.value, defects.value, plant.value.commissioningDate))
  const gridRoot = computed(() => chain.value.roots.map((id) => chain.value.nodes[id]).find((node) => node?.type === '并网点'))
  const validPassCount = computed(() => activePasses.value.length)

  function passAt(branchRootId: string) {
    return activePasses.value.find((pass) => pass.branchRootId === branchRootId)
  }
  function ancestors(equipmentId: string) {
    return ancestorsOf(equipmentId, chain.value)
  }

  const selectedEquipment = computed(() => equipment.value.find((item) => item.id === selectedEquipmentId.value))
  const stats = computed(() => {
    const items = equipment.value.flatMap((item) => item.items)
    return {
      total: items.length,
      passed: items.filter((item) => item.status === '合格').length,
      failed: items.filter((item) => item.status === '不合格' || item.status === '待复验').length,
      openDefects: defects.value.filter((item) => !['已关闭', '带条件通过'].includes(item.status)).length
    }
  })
  const preflight = computed(() => {
    const blocking: string[] = []
    const root = gridRoot.value
    if (root) {
      if (root.subtreeState === 'block') {
        blocking.push(root.firstProblem ? `子树被阻断：${root.firstProblem.nodeName} — ${root.firstProblem.reason.title}` : '设备树存在阻断项')
      }
      if (root.effectiveState === 'temp') blocking.push('当前仅为临时放行覆盖，阻断项未真正消除，不能最终签署')
    }
    const items = equipment.value.flatMap((item) => item.items)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')
    if (equipment.value.flatMap((item) => item.certificates).some((item) => !item.verified)) blocking.push('存在未核验证书')
    const expired = equipment.value.flatMap((item) => item.certificates).some((item) => item.expiresAt < plant.value.commissioningDate)
    if (expired) blocking.push('证书在并网日期前失效')
    return { allowed: blocking.length === 0, blocking }
  })

  /* ---------- 快照写入 / 崩溃恢复 ---------- */

  function flushSnapshot(snapshot: Snapshot) {
    if (!import.meta.client) return
    const payload = JSON.stringify(snapshot)
    // 两阶段写入：先写临时区并回读校验，再提交为主快照；中途失败后主快照仍是最后完整树快照
    localStorage.setItem(TMP_KEY, payload)
    const verified = JSON.parse(localStorage.getItem(TMP_KEY) || 'null')
    if (!isValidSnapshot(verified) || JSON.stringify(verified) !== payload) {
      throw new Error('临时快照校验失败')
    }
    if (forceNextFailure) {
      forceNextFailure = false
      throw new Error('SIMULATED_WRITE_FAILURE')
    }
    localStorage.setItem(STORAGE_KEY, payload)
    localStorage.removeItem(TMP_KEY)
  }

  function readPersisted(): { snapshot: Snapshot | null; legacy: boolean } {
    if (!import.meta.client) return { snapshot: null, legacy: false }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (isValidSnapshot(parsed)) return { snapshot: parsed, legacy: false }
      } catch { /* fall through to recovery */ }
    }
    return { snapshot: null, legacy: false }
  }

  function hydrate() {
    if (!import.meta.client || hydrated.value) return
    try {
      let { snapshot } = readPersisted()
      let migrated = false
      if (!snapshot) {
        // 兼容旧版本数据（可能缺少父级关系/放行单字段）
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw)
          if (Array.isArray(legacy.equipment)) {
            snapshot = {
              plant: legacy.plant ?? clone(seedPlant),
              equipment: legacy.equipment,
              defects: legacy.defects ?? [],
              audit: legacy.audit ?? [],
              passes: [],
              repairNotes: [],
              treeVersion: 1,
              savedAt: now()
            }
            migrated = true
          }
        }
      }
      if (snapshot) {
        restoreFromSnapshot(snapshot, { migrated, tmpPending: !!localStorage.getItem(TMP_KEY) })
      } else {
        const fresh = freshState()
        assignState(fresh)
        try { flushSnapshot(fresh) } catch { /* 首次写入失败时仅保留内存态 */ }
      }
    } catch {
      const fresh = freshState()
      assignState(fresh)
    }
    hydrated.value = true
  }

  function restoreFromSnapshot(snapshot: Snapshot, opts: { migrated?: boolean; tmpPending?: boolean; manual?: boolean } = {}) {
    // 旧数据缺少父级关系时，先按现有节点层级补齐再参与计算
    const repaired = repairHierarchy(snapshot.equipment)
    plant.value = snapshot.plant
    equipment.value = repaired.nodes
    defects.value = snapshot.defects
    audit.value = snapshot.audit
    passes.value = snapshot.passes ?? []
    repairNotes.value = [...repaired.repairs, ...(snapshot.repairNotes ?? [])]
    treeVersion.value = snapshot.treeVersion
    lastSnapshotAt.value = snapshot.savedAt
    if (import.meta.client) {
      if (opts.tmpPending) localStorage.removeItem(TMP_KEY)
      const messages: string[] = []
      if (opts.tmpPending) messages.push('检测到写入中途残留的临时数据，已丢弃并恢复至最后完整树快照')
      if (opts.migrated) messages.push('已迁移旧版数据')
      if (repaired.repairs.length) messages.push(`按现有层级补齐了${repaired.repairs.length}处缺失的父级关系`)
      if (opts.manual) messages.push(`已从最后完整树快照恢复（V${snapshot.treeVersion}，${snapshot.savedAt.replace('T', ' ').slice(0, 16)}）`)
      recoveryNotice.value = messages.join('；')
      if (!opts.tmpPending) {
        // 恢复后立即把修复过的完整树重新落盘
        const restored: Snapshot = {
          plant: plant.value, equipment: equipment.value, defects: defects.value, audit: audit.value,
          passes: passes.value, repairNotes: repairNotes.value, treeVersion: treeVersion.value, savedAt: now()
        }
        try { flushSnapshot(restored) } catch { /* keep recovered in-memory state */ }
      }
    }
  }

  function assignState(snapshot: Snapshot) {
    plant.value = snapshot.plant
    equipment.value = snapshot.equipment
    defects.value = snapshot.defects
    audit.value = snapshot.audit
    passes.value = snapshot.passes
    repairNotes.value = snapshot.repairNotes
    treeVersion.value = snapshot.treeVersion
    lastSnapshotAt.value = snapshot.savedAt
  }

  function recoverFromSnapshot(): CommitResult {
    const persisted = readPersisted().snapshot
    if (!persisted) return { ok: false, message: '没有可恢复的完整快照' }
    restoreFromSnapshot(persisted, { manual: true })
    return { ok: true, message: `已恢复至最后完整树快照 V${persisted.treeVersion}`, restoredVersion: persisted.treeVersion }
  }

  /* ---------- 事务提交：先改草稿 → 逐级重算 → 原子落盘，失败回滚并恢复 ---------- */

  const sourceTitle = (key: string, draft: Draft): string => {
    const [kind, id] = key.split(':')
    if (kind === '缺陷') return draft.defects.find((item) => item.id === id)?.title ?? key
    for (const node of draft.equipment) {
      if (kind === '验收项') {
        const item = node.items.find((value) => value.id === id)
        if (item) return item.standard
      } else if (kind === '证书') {
        const cert = node.certificates.find((value) => value.id === id)
        if (cert) return cert.name
      }
    }
    return key
  }

  function commit(label: string, mutate: (draft: Draft) => void, auditContext?: { entityId: string; action: string; operator: string; detail: string }): CommitResult {
    const draft: Draft = {
      plant: clone(plant.value),
      equipment: clone(equipment.value),
      defects: clone(defects.value),
      audit: clone(audit.value),
      passes: clone(passes.value),
      repairNotes: clone(repairNotes.value)
    }
    mutate(draft)
    if (auditContext) pushAudit(draft, auditContext.entityId, auditContext.action, auditContext.operator, auditContext.detail)

    // 依据变化 → 上游节点立即失效并逐级重算
    const beforeStates = new Map(draft.passes.map((pass) => [pass.id, pass.state]))
    const tree = evaluateTree(draft.equipment, draft.defects, draft.plant.commissioningDate, draft.passes.filter(isPassActive))
    const allSignatures = buildSignatures(draft.equipment, draft.defects, draft.plant.commissioningDate)
    draft.passes = recomputePasses(draft.passes, tree, allSignatures)
    draft.passes.forEach((pass) => {
      if (pass.changedSources) {
        pass.changedSources = pass.changedSources.map((change: ChangedSource) => ({ ...change, title: sourceTitle(change.key, draft) }))
      }
      const before = beforeStates.get(pass.id)
      if (before !== pass.state && (pass.state === '已失效' || pass.state === '待确认')) {
        const basis = pass.invalidBasis
        const detail = pass.state === '已失效'
          ? `分支「${pass.branchName}」放行单${label}后失效${basis ? `，最先出问题：${basis.nodeName} · ${basis.reason.title}（${basis.reason.detail}）` : ''}`
          : `分支「${pass.branchName}」阻断项已消除，等待负责人重新确认续期`
        pushAudit(draft, pass.id, pass.state === '已失效' ? '放行单逐级失效' : '放行单待重新确认', '系统', detail)
      }
    })

    const snapshot: Snapshot = {
      plant: draft.plant,
      equipment: draft.equipment,
      defects: draft.defects,
      audit: draft.audit,
      passes: draft.passes,
      repairNotes: draft.repairNotes,
      treeVersion: treeVersion.value + 1,
      savedAt: now()
    }

    try {
      flushSnapshot(snapshot)
    } catch (error) {
      const persisted = readPersisted().snapshot
      const recoveredVersion = persisted?.treeVersion ?? treeVersion.value
      if (persisted) restoreFromSnapshot(persisted)
      recoveryNotice.value = `「${label}」写入中途失败，已回滚并从最后完整树快照恢复（V${recoveredVersion}），本次变更未生效`
      return { ok: false, message: '写入中途失败，已从最后完整树快照恢复', recovered: true, restoredVersion: recoveredVersion }
    }

    assignState(snapshot)
    recoveryNotice.value = ''
    return { ok: true, message: '已提交并逐级重算放行链' }
  }

  /* ---------- 验收项 / 证书 / 缺陷变更 ---------- */

  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>) {
    const target = equipment.value.find((node) => node.id === equipmentId)?.items.find((item) => item.id === itemId)
    if (!target) return { ok: false, message: '验收项不存在' }
    return commit('更新验收项', (draft) => {
      const item = draft.equipment.find((node) => node.id === equipmentId)?.items.find((value) => value.id === itemId)
      if (!item) return
      Object.assign(item, patch, { version: item.version + 1 })
    }, { entityId: itemId, action: '更新验收项', operator: '当前用户', detail: `${target.standard} → ${patch.status ?? target.status}（V${target.version + 1}）` })
  }

  function updateCertificate(equipmentId: string, certId: string, patch: Partial<Certificate>) {
    const target = equipment.value.find((node) => node.id === equipmentId)?.certificates.find((cert) => cert.id === certId)
    if (!target) return { ok: false, message: '证书不存在' }
    const versionBump = patch.version !== undefined && patch.version !== target.version
    return commit(versionBump ? '证书换版' : '更新证书', (draft) => {
      const cert = draft.equipment.find((node) => node.id === equipmentId)?.certificates.find((value) => value.id === certId)
      if (!cert) return
      Object.assign(cert, patch)
      if (versionBump) cert.version = patch.version!
    }, {
      entityId: certId,
      action: versionBump ? '证书换版' : '更新证书',
      operator: '当前用户',
      detail: versionBump ? `${target.name}换版 V${target.version} → V${patch.version}` : `${target.name}核验信息更新`
    })
  }

  function reopenDefect(id: string, note: string) {
    const target = defects.value.find((item) => item.id === id)
    if (!target) return { ok: false, message: '缺陷不存在' }
    return commit('缺陷重新打开', (draft) => {
      const defect = draft.defects.find((item) => item.id === id)
      if (!defect) return
      defect.status = '整改中'
      defect.decisionNote = ''
      defect.version += 1
    }, { entityId: id, action: '缺陷重新打开', operator: '当前用户', detail: note || `${target.title}重新进入整改，原放行结论失效` })
  }

  function assignDefect(id: string, owner: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    return commit('分派缺陷', (draft) => {
      const target = draft.defects.find((item) => item.id === id)
      if (!target) return
      target.owner = owner
      target.status = '整改中'
      target.version += 1
    }, { entityId: id, action: '分派缺陷', operator: '验收负责人', detail: `责任方调整为${owner}` })
  }

  function addReply(id: string, reply: PartyReply) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect || !reply.content || !reply.evidence) return { ok: false, message: '回复内容和证据均不能为空' }
    const result = commit('提交处理说明', (draft) => {
      const target = draft.defects.find((item) => item.id === id)
      if (!target) return
      target.replies.unshift(reply)
      target.status = '待联合复验'
      target.version += 1
    }, { entityId: id, action: `${reply.party}提交处理说明`, operator: reply.owner, detail: reply.content })
    return result.ok ? { ok: true, message: '已提交处理说明并进入联合复验' } : result
  }

  function addRetest(id: string, result: string, passed: boolean) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    return commit('联合复验', (draft) => {
      const target = draft.defects.find((item) => item.id === id)
      if (!target) return
      target.retests.unshift({ round: target.retests.length + 1, passed, result, tester: '联合验收组', testedAt: now() })
      target.status = passed ? '已关闭' : '整改中'
      target.version += 1
    }, { entityId: id, action: '执行联合复验', operator: '联合验收组', detail: result })
  }

  function decideDefect(id: string, status: '已关闭' | '带条件通过' | '整改中', note: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (status === '已关闭' && !defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复验记录，不能关闭' }
    if (status === '带条件通过' && !note.trim()) return { ok: false, message: '带条件通过必须说明限制条件' }
    const label = status === '整改中' ? '缺陷退回整改' : '验收决定'
    const result = commit(label, (draft) => {
      const target = draft.defects.find((item) => item.id === id)
      if (!target) return
      target.status = status
      target.decisionNote = note
      target.version += 1
    }, { entityId: id, action: `验收决定：${status}`, operator: '验收负责人', detail: note || '完成整改闭环' })
    return result.ok ? { ok: true, message: `缺陷已更新为${status}` } : result
  }

  /* ---------- 分支放行单：同一分支只保留一张有效单 ---------- */

  // 两个负责人几乎同时申请时，用进程内队列串行化：后到的申请命中已存在的有效单并被拒绝
  let applyQueue: Promise<CommitResult & { passId?: string }> = Promise.resolve({ ok: true, message: '' })

  function applyRelease(branchRootId: string, owner: string, reason: string, latencyMs = 500) {
    const run = applyQueue.then(() => applyReleaseInner(branchRootId, owner, reason, latencyMs))
    applyQueue = run.catch(() => undefined).then(() => undefined) as unknown as Promise<CommitResult & { passId?: string }>
    return run
  }

  function applyReleaseInner(branchRootId: string, owner: string, reason: string, latencyMs: number): Promise<CommitResult & { passId?: string }> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const branch = equipment.value.find((node) => node.id === branchRootId)
        if (!branch) return resolve({ ok: false, message: '分支节点不存在' })
        if (!reason.trim()) return resolve({ ok: false, message: '必须填写临时放行事由' })

        // 临界区检查：有效单已存在则拒绝（只保留一张有效单）
        const existing = passes.value.find((pass) => pass.branchRootId === branchRootId && isPassActive(pass))
        if (existing) {
          return resolve({ ok: false, message: `该分支已存在${existing.state}单 ${existing.id}（${existing.owner} 签发），只保留一张有效单`, passId: existing.id })
        }

        const id = `RP-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(++passSeq).padStart(3, '0')}`
        const issuedAt = now()
        const result = commit('申请临时放行', (draft) => {
          const signaturesNow = subtreeSignatures(branchRootId, draft.equipment, draft.defects, draft.plant.commissioningDate)
          const pass: ReleasePass = {
            id,
            branchRootId,
            branchName: branch.name,
            owner,
            reason,
            issuedAt,
            state: '临时放行中',
            signatures: signaturesNow,
            treeVersion: treeVersion.value + 1,
            history: [{ at: issuedAt, action: '签发临时放行', operator: owner, detail: reason }]
          }
          draft.passes.push(pass)
        }, { entityId: branchRootId, action: '申请分支临时放行', operator: owner, detail: `${branch.name}：${reason}` })

        if (result.ok) resolve({ ...result, passId: id })
        else resolve(result)
      }, latencyMs)
    })
  }

  function reconfirmPass(passId: string, operator: string) {
    const pass = passes.value.find((item) => item.id === passId)
    if (!pass) return { ok: false, message: '放行单不存在' }
    if (pass.state !== '待确认') return { ok: false, message: '仅待确认的放行单可以重新确认' }
    const root = chain.value.nodes[pass.branchRootId]
    if (root?.subtreeState === 'block') {
      return { ok: false, message: `仍有阻断项未解决（${root.firstProblem ? `${root.firstProblem.nodeName} · ${root.firstProblem.reason.title}` : '见设备树'}），不能续期` }
    }
    return commit('重新确认放行', (draft) => {
      const target = draft.passes.find((item) => item.id === passId)
      if (!target) return
      target.signatures = subtreeSignatures(target.branchRootId, draft.equipment, draft.defects, draft.plant.commissioningDate)
      target.state = '已续期'
      target.changedSources = []
      target.history.push({ at: now(), action: '重新确认续期', operator, detail: '子项问题已解决并重新确认，原临时放行继续有效' })
    }, { entityId: passId, action: '重新确认临时放行', operator, detail: `${pass.branchName}：重新确认后续期` })
  }

  function closePass(passId: string, operator: string) {
    const pass = passes.value.find((item) => item.id === passId)
    if (!pass) return { ok: false, message: '放行单不存在' }
    return commit('撤销放行单', (draft) => {
      const target = draft.passes.find((item) => item.id === passId)
      if (!target) return
      target.state = '已失效'
      target.invalidatedAt = now()
      target.history.push({ at: now(), action: '撤销', operator, detail: '负责人主动撤销临时放行' })
    }, { entityId: passId, action: '撤销放行单', operator, detail: `${pass.branchName}放行单撤销` })
  }

  /* ---------- 旧数据导入（缺父级关系）与故障演练 ---------- */

  function importLegacyEquipment() {
    const legacyIds = ['EQ-AR2', 'EQ-INV12', 'EQ-CB112']
    if (equipment.value.some((node) => legacyIds.includes(node.id))) {
      return { ok: false, message: '旧数据示例已导入过' }
    }
    return commit('导入旧数据', (draft) => {
      draft.equipment.push(
        {
          id: 'EQ-AR2', parentId: null, name: '2号方阵', type: '方阵', code: 'ARRAY-02', status: '待验收',
          items: [{ id: 'IT-A2', standard: '支架接地电阻满足设计限值', method: '接地电阻测试仪', condition: '晴好天气', status: '待检查', measured: '', evidence: '', version: 1 }], certificates: []
        },
        {
          id: 'EQ-INV12', parentId: 'EQ-GHOST-MISSING', name: '1-2号逆变器', type: '逆变器', code: 'INV-1-2', status: '验收中',
          items: [{ id: 'IT-I3', standard: '并离网切换逻辑正确', method: '模拟电网掉电', condition: '逆变器带载', status: '不合格', measured: '切换延时3.2s超标', evidence: '切换录波.dat', version: 1 }],
          certificates: [{ id: 'C-I2', name: '逆变器型式试验报告', issuer: '中国电科院', expiresAt: '2028-03-15', version: 1, verified: true }]
        },
        {
          id: 'EQ-CB112', parentId: null, name: '1-1-2汇流箱', type: '汇流箱', code: 'CB-1-1-2', status: '待验收',
          items: [{ id: 'IT-C2', standard: '熔断器规格与设计一致', method: '逐路核对', condition: '箱体断电', status: '待检查', measured: '', evidence: '', version: 1 }], certificates: []
        }
      )
      // 导入后按现有层级补齐父级关系，再让其参与计算
      const repaired = repairHierarchy(draft.equipment)
      draft.equipment = repaired.nodes
      draft.repairNotes.push(...repaired.repairs)
    }, { entityId: 'LEGACY', action: '导入缺少父级关系的旧数据', operator: '系统管理员', detail: '2号方阵/1-2号逆变器/1-1-2汇流箱，按现有节点层级补齐后参与放行计算' })
  }

  function simulateWriteFailure() {
    forceNextFailure = true
    return commit('写入中断演练', (draft) => {
      pushAudit(draft, 'SYSTEM', '写入中断演练', '系统管理员', '制造一次写入中途失败，验证从最后完整树快照恢复')
    })
  }

  function signOff() {
    if (!preflight.value.allowed) return { ok: false, message: preflight.value.blocking.join('；') }
    const result = commit('签署交付版本', (draft) => {
      draft.plant.status = '已签署'
      draft.plant.version += 1
      draft.equipment.forEach((node) => { node.status = '已验收' })
    }, { entityId: plant.value.id, action: '签署交付版本', operator: '验收负责人陆川', detail: `锁定V${plant.value.version + 1}并生成交付包` })
    return result.ok ? { ok: true, message: '签署完成，交付版本已锁定' } : result
  }

  function reset() {
    const fresh = freshState()
    assignState(fresh)
    recoveryNotice.value = ''
    if (import.meta.client) {
      try {
        flushSnapshot(fresh)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      } catch { /* in-memory only */ }
    }
  }

  return {
    plant, equipment, defects, audit, passes, repairNotes, treeVersion, lastSnapshotAt, recoveryNotice,
    selectedEquipmentId, keyword, hydrated,
    chain, signatures, gridRoot, activePasses, validPassCount, passAt, ancestors,
    selectedEquipment, stats, preflight,
    hydrate, recoverFromSnapshot,
    updateItem, updateCertificate, reopenDefect, assignDefect, addReply, addRetest, decideDefect,
    applyRelease, reconfirmPass, closePass,
    importLegacyEquipment, simulateWriteFailure, signOff, reset
  }
})
