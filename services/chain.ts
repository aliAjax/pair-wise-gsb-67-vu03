import type {
  AcceptanceDefect,
  ChainReason,
  ChainState,
  Certificate,
  ChangedSource,
  EquipmentNode,
  FirstProblem,
  ReleasePass
} from '../types/domain'

/** 设备层级：数值越大越靠近组串侧（叶子），用于旧数据缺父级关系时按现有层级补齐 */
export const TYPE_RANK: Record<EquipmentNode['type'], number> = {
  并网点: 0,
  变压器: 1,
  方阵: 2,
  逆变器: 3,
  汇流箱: 4
}

export interface ChainNodeResult {
  id: string
  parentId: string | null
  name: string
  code: string
  type: EquipmentNode['type']
  depth: number
  childIds: string[]
  /** 节点自身验收项/证书/缺陷聚合出的状态（不含子节点、不含放行单覆盖） */
  rawState: ChainState
  /** 含子树逐级聚合、但不含放行单覆盖的状态 */
  subtreeState: ChainState
  /** 页面展示状态：放行单覆盖后的有效状态 */
  effectiveState: ChainState
  reasons: ChainReason[]
  /** 子树内最先出问题的子节点及其依据（DFS 最左最深优先） */
  firstProblem: FirstProblem | null
  signatures: Record<string, string>
  coveredByPassId?: string
}

export interface ChainTreeResult {
  nodes: Record<string, ChainNodeResult>
  roots: string[]
}

const OPEN_DEFECT_STATES = ['待分派', '整改中', '待联合复验']
const CLOSED_DEFECT_STATES = ['已关闭', '带条件通过']

/* ---------------- 旧数据父级关系修复 ---------------- */

/**
 * 旧数据缺少父级关系时，按现有节点层级补齐：
 * 1) parentId 为空：挂到层级紧邻的上一级、顺序上最近的前一个节点；
 * 2) parentId 指向不存在的节点（悬空）：同样规则重挂并记录；
 * 3) 父级层级不小于本节点（倒挂）：按层级就近前挂；
 * 4) 形成环：断开环上最可疑的边后重新挂载。
 */
export function repairHierarchy(input: EquipmentNode[]): { nodes: EquipmentNode[]; repairs: import('../types/domain').RepairNote[] } {
  // 输入可能是 Pinia/Vue 响应式代理，structuredClone 无法克隆 Proxy，数据本身可 JSON 序列化
  const nodes = JSON.parse(JSON.stringify(input)) as EquipmentNode[]
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const repairs: import('../types/domain').RepairNote[] = []
  const now = () => new Date().toISOString()

  const nearestUpperParent = (index: number, rank: number, excludeId?: string): EquipmentNode | null => {
    for (let level = rank - 1; level >= 0; level -= 1) {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (nodes[i].id !== excludeId && TYPE_RANK[nodes[i].type] === level) return nodes[i]
      }
    }
    // 没有恰好上一级时，取前面任何层级更高的节点
    for (let i = index - 1; i >= 0; i -= 1) {
      if (nodes[i].id !== excludeId && TYPE_RANK[nodes[i].type] < rank) return nodes[i]
    }
    return null
  }

  nodes.forEach((node, index) => {
    const rank = TYPE_RANK[node.type]
    let reason = ''
    let oldParentId = node.parentId
    if (rank === 0) {
      if (node.parentId !== null) { reason = '并网点应为根节点，旧数据存在上级引用，已断开' }
      node.parentId = null
    } else if (node.parentId === null) {
      reason = '旧数据缺少父级关系，按现有节点层级补齐'
      node.parentId = nearestUpperParent(index, rank)?.id ?? null
    } else {
      const parent = byId.get(node.parentId)
      if (!parent) {
        reason = '父级节点不存在（悬空引用），按现有节点层级补齐'
        node.parentId = nearestUpperParent(index, rank)?.id ?? null
      } else if (TYPE_RANK[parent.type] >= rank) {
        reason = `父级类型「${parent.type}」与节点层级倒挂，按层级就近补齐`
        node.parentId = nearestUpperParent(index, rank)?.id ?? null
      }
    }
    if (reason) {
      repairs.push({
        nodeId: node.id,
        nodeName: node.name,
        oldParentId,
        newParentId: node.parentId,
        reason,
        repairedAt: now()
      })
    }
  })

  // 环检测：沿父链追溯，命中自身即断边重挂
  nodes.forEach((node, index) => {
    const seen = new Set<string>()
    let cur: EquipmentNode | undefined = node
    while (cur && cur.parentId !== null) {
      if (seen.has(cur.id)) {
        const target = cur
        const oldParentId = target.parentId
        target.parentId = nearestUpperParent(index, TYPE_RANK[target.type], target.id)?.id ?? null
        repairs.push({
          nodeId: target.id,
          nodeName: target.name,
          oldParentId,
          newParentId: target.parentId,
          reason: '父级链形成环路，已断开并按层级补齐',
          repairedAt: now()
        })
        break
      }
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  })

  return { nodes, repairs }
}

/* ---------------- 节点依据与指纹 ---------------- */

function certReasons(node: EquipmentNode, commissioningDate: string): ChainReason[] {
  const out: ChainReason[] = []
  node.certificates.forEach((cert: Certificate) => {
    if (!cert.verified) {
      out.push({ kind: '证书', sourceId: cert.id, nodeId: node.id, title: cert.name, detail: '证书缺失或未核验，不能作为放行依据', version: cert.version, state: 'block' })
    } else if (cert.expiresAt < commissioningDate) {
      out.push({ kind: '证书', sourceId: cert.id, nodeId: node.id, title: cert.name, detail: `证书有效期至${cert.expiresAt}，早于并网日期${commissioningDate}`, version: cert.version, state: 'block' })
    }
  })
  return out
}

function itemReasons(node: EquipmentNode): ChainReason[] {
  return node.items.map((item): ChainReason => {
    const state: ChainState = item.status === '不合格' ? 'block' : item.status === '待复验' ? 'temp' : item.status === '待检查' ? 'block' : 'pass'
    const detail = item.status === '合格'
      ? `实测：${item.measured || '—'}`
      : item.status === '待检查'
        ? '验收项尚未检查，缺少结论与证据'
        : `${item.status}：${item.measured || '暂无实测数据'}`
    return { kind: '验收项', sourceId: item.id, nodeId: node.id, title: item.standard, detail, version: item.version, state }
  }).filter((reason) => reason.state !== 'pass')
}

function defectReasons(node: EquipmentNode, defects: AcceptanceDefect[]): ChainReason[] {
  return defects
    .filter((defect) => defect.equipmentId === node.id)
    .map((defect): ChainReason => {
      const state: ChainState = defect.status === '带条件通过' ? 'temp' : OPEN_DEFECT_STATES.includes(defect.status) ? 'block' : 'pass'
      return {
        kind: '缺陷',
        sourceId: defect.id,
        nodeId: node.id,
        title: defect.title,
        detail: `${defect.severity}缺陷，当前状态「${defect.status}」${defect.decisionNote ? `；${defect.decisionNote}` : ''}`,
        version: defect.version,
        state
      }
    })
    .filter((reason) => reason.state !== 'pass')
}

/** 节点自身（不含子节点）依据 */
export function ownReasons(node: EquipmentNode, defects: AcceptanceDefect[], commissioningDate: string): ChainReason[] {
  return [...itemReasons(node), ...certReasons(node, commissioningDate), ...defectReasons(node, defects)]
}

const STATE_RANK: Record<ChainState, number> = { block: 3, temp: 2, pass: 1 }
export function worseState(a: ChainState, b: ChainState): ChainState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b
}

/* ---------------- 指纹 ---------------- */

export function signatureKey(kind: ChainReason['kind'], sourceId: string) {
  return `${kind}:${sourceId}`
}

export function signatureValue(reason: ChainReason) {
  return `v${reason.version}:${reason.state}`
}

export const SIGNATURE_LABELS: Record<string, string> = {
  '验收项': '验收项',
  '证书': '证书',
  '缺陷': '缺陷'
}

/** 从验收项/证书/缺陷直接生成指纹（供签发新单时使用） */
export function buildSignatures(equipment: EquipmentNode[], defects: AcceptanceDefect[], commissioningDate: string): Record<string, string> {
  const result: Record<string, string> = {}
  equipment.forEach((node) => {
    ownReasons(node, defects, commissioningDate).forEach((reason) => {
      result[signatureKey(reason.kind, reason.sourceId)] = signatureValue(reason)
    })
    // 已合格的验收项、已闭环的缺陷也要入指纹：它们重新打开/换版时同样触发失效
    node.items.forEach((item) => {
      const key = signatureKey('验收项', item.id)
      if (!(key in result)) result[key] = `v${item.version}:合格`
    })
    node.certificates.forEach((cert) => {
      const key = signatureKey('证书', cert.id)
      if (!(key in result)) result[key] = `v${cert.version}:${cert.verified && cert.expiresAt >= commissioningDate ? '有效' : '异常'}`
    })
  })
  defects.forEach((defect) => {
    const key = signatureKey('缺陷', defect.id)
    if (!(key in result)) result[key] = `v${defect.version}:${defect.status}`
  })
  return result
}

/* ---------------- 树形逐级聚合 ---------------- */

function firstProblemDFS(
  nodeId: string,
  byId: Map<string, EquipmentNode>,
  childrenOf: Map<string | null, string[]>,
  results: Map<string, ChainNodeResult>
): FirstProblem | null {
  // 收集子树内全部异常依据：阻断(block)优先于临时(temp)，同级按 DFS 先序（自身→长子）定位
  const candidates: Array<{ nodeId: string; path: string[]; reason: ChainReason; state: ChainState }> = []
  const walk = (id: string, trail: string[]) => {
    const result = results.get(id)
    if (!result) return
    const path = [...trail, id]
    // 节点内依据顺序：验收项 → 证书 → 缺陷；先挑阻断
    const ordered = [...result.reasons].sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state])
    ordered.forEach((reason) => candidates.push({ nodeId: id, path, reason, state: reason.state }))
    ;(childrenOf.get(id) ?? []).forEach((childId) => walk(childId, path))
  }
  walk(nodeId, [])
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    const rankGap = STATE_RANK[b.state] - STATE_RANK[a.state]
    if (rankGap !== 0) return rankGap
    return 0 // 同级别保持 DFS 先序（Array.prototype.sort 稳定）
  })
  const first = candidates[0]
  return { nodeId: first.nodeId, nodeName: byId.get(first.nodeId)!.name, path: first.path, reason: first.reason }
}

export function evaluateTree(
  equipment: EquipmentNode[],
  defects: AcceptanceDefect[],
  commissioningDate: string,
  activePasses: ReleasePass[] = []
): ChainTreeResult {
  const { nodes } = repairHierarchy(equipment)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const childrenOf = new Map<string | null, string[]>()
  nodes.forEach((node) => {
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node.id)
    childrenOf.set(node.parentId, list)
  })
  const ordered = (ids?: string[]) => (ids ?? []).sort((a, b) => {
    const na = byId.get(a)!; const nb = byId.get(b)!
    return TYPE_RANK[na.type] - TYPE_RANK[nb.type] || na.id.localeCompare(nb.id)
  })
  childrenOf.forEach((ids, key) => childrenOf.set(key, ordered(ids)))

  const passByRoot = new Map(activePasses.map((pass) => [pass.branchRootId, pass]))
  const subtreePassRoots = new Map<string, string>()
  activePasses.forEach((pass) => {
    let cur: string | null = pass.branchRootId
    while (cur) {
      subtreePassRoots.set(cur, pass.branchRootId)
      cur = byId.get(cur)?.parentId ?? null
    }
  })

  const results = new Map<string, ChainNodeResult>()

  const postorder = (nodeId: string, depth: number): ChainNodeResult => {
    const node = byId.get(nodeId)!
    const childIds = childrenOf.get(nodeId) ?? []
    const childResults = childIds.map((id) => postorder(id, depth + 1))
    const reasons = ownReasons(node, defects, commissioningDate)
    const rawState: ChainState = reasons.reduce<ChainState>((acc, reason) => worseState(acc, reason.state), 'pass')

    const signatures: Record<string, string> = {}
    reasons.forEach((reason) => { signatures[signatureKey(reason.kind, reason.sourceId)] = signatureValue(reason) })
    node.items.forEach((item) => {
      const key = signatureKey('验收项', item.id)
      if (!(key in signatures)) signatures[key] = `v${item.version}:合格`
    })
    node.certificates.forEach((cert) => {
      const key = signatureKey('证书', cert.id)
      if (!(key in signatures)) signatures[key] = `v${cert.version}:${cert.verified && cert.expiresAt >= commissioningDate ? '有效' : '异常'}`
    })
    defects.filter((defect) => defect.equipmentId === node.id).forEach((defect) => {
      const key = signatureKey('缺陷', defect.id)
      if (!(key in signatures)) signatures[key] = `v${defect.version}:${CLOSED_DEFECT_STATES.includes(defect.status) ? defect.status : '未闭环'}`
    })

    let subtreeState = rawState
    childResults.forEach((child) => { subtreeState = worseState(subtreeState, child.subtreeState) })

    const result: ChainNodeResult = {
      id: nodeId, parentId: node.parentId, name: node.name, code: node.code, type: node.type, depth,
      childIds, rawState, subtreeState, effectiveState: subtreeState,
      reasons, firstProblem: null, signatures
    }
    results.set(nodeId, result)
    return result
  }

  const roots = ordered(childrenOf.get(null))
  roots.forEach((id) => postorder(id, 0))

  // 放行单覆盖：分支根子树内 block 一律夹成 temp，并阻断向上游传播
  activePasses.forEach((pass) => {
    const clamp = (nodeId: string) => {
      const result = results.get(nodeId)
      if (!result) return
      result.coveredByPassId = pass.id
      if (result.subtreeState === 'block') result.effectiveState = 'temp'
      result.childIds.forEach(clamp)
    }
    if (results.has(pass.branchRootId)) clamp(pass.branchRootId)
  })

  // 有效状态需要第二次后序：分支根被夹成 temp 后，其父链按 effective 聚合
  const effectivePost = (nodeId: string): ChainState => {
    const result = results.get(nodeId)!
    if (result.coveredByPassId) return result.effectiveState
    let state = result.rawState
    result.childIds.forEach((childId) => { state = worseState(state, effectivePost(childId)) })
    result.effectiveState = state
    return state
  }
  roots.forEach(effectivePost)

  // 最先出问题的子节点：阻断优先、同级按 DFS 先序（自身→长子）定位
  results.forEach((result) => {
    result.firstProblem = firstProblemDFS(result.id, byId, childrenOf, results)
  })

  return { nodes: Object.fromEntries(results), roots }
}

/* ---------------- 放行单生命周期 ---------------- */

const ACTIVE_PASS_STATES: ReleasePass['state'][] = ['临时放行中', '待确认', '已续期', '正式放行']

export function isPassActive(pass: ReleasePass) {
  return ACTIVE_PASS_STATES.includes(pass.state)
}

export function diffSignatures(before: Record<string, string>, after: Record<string, string>): ChangedSource[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changes: ChangedSource[] = []
  keys.forEach((key) => {
    const b = before[key]
    const a = after[key]
    if (b !== a) changes.push({ key, title: key, before: b ?? '（新增）', after: a ?? '（已删除）' })
  })
  return changes
}

/**
 * 证书换版、验收项结果变化或缺陷重新打开后重算：
 * - 分支子树内依据发生变化且仍被阻断 → 临时放行立即失效，逐级重算上游；
 * - 变化后阻断消除（子项问题已解决）→ 进入待确认，负责人重新确认后续期/转正式；
 * - 已续期/正式单遇到再次回归阻断 → 同样立即失效。
 */
export function recomputePasses(
  passes: ReleasePass[],
  tree: ChainTreeResult,
  allSignatures: Record<string, string>
): ReleasePass[] {
  const now = new Date().toISOString()
  return passes.map((pass) => {
    if (pass.state === '已失效') return pass
    const root = tree.nodes[pass.branchRootId]
    if (!root) {
      return { ...pass, state: '已失效', invalidatedAt: now, history: [...pass.history, { at: now, action: '失效', operator: '系统', detail: '分支根节点不存在，放行单自动失效' }] }
    }
    const changed = diffSignatures(pass.signatures, allSignatures)
    if (changed.length === 0) return pass

    const subtreeBlocked = root.subtreeState === 'block'
    const next: ReleasePass = { ...pass, changedSources: changed, treeVersion: pass.treeVersion + 1 }
    if (subtreeBlocked) {
      next.state = '已失效'
      next.invalidatedAt = now
      next.invalidBasis = root.firstProblem ?? undefined
      next.history = [...pass.history, {
        at: now,
        action: '失效',
        operator: '系统',
        detail: `${changed.length}项依据变化（${changed.slice(0, 2).map((item) => item.title).join('、')}${changed.length > 2 ? '等' : ''}），上游节点立即失效并逐级重算`
      }]
    } else if (pass.state === '临时放行中') {
      next.state = '待确认'
      next.history = [...pass.history, {
        at: now,
        action: '待确认',
        operator: '系统',
        detail: '子项问题已解决，请负责人重新确认后临时放行方可继续'
      }]
    } else {
      // 已续期/正式放行：依据变化但当前无阻断，同样需要重新确认
      next.state = '待确认'
      next.history = [...pass.history, {
        at: now,
        action: '待确认',
        operator: '系统',
        detail: '放行依据发生版本变化，需重新确认'
      }]
    }
    return next
  })
}

/** 取某节点到根的祖先链（含自身，自根向下） */
export function ancestorsOf(nodeId: string, tree: ChainTreeResult): ChainNodeResult[] {
  const chain: ChainNodeResult[] = []
  let cur: ChainNodeResult | undefined = tree.nodes[nodeId]
  while (cur) {
    chain.unshift(cur)
    cur = cur.parentId ? tree.nodes[cur.parentId] : undefined
  }
  return chain
}

/** 将 验收项:IT-G1 形式的指纹键格式化为中文描述 */
export function formatSignatureKey(key: string): string {
  const [kind, id] = key.split(':')
  return `${SIGNATURE_LABELS[kind] ?? kind} ${id}`
}
