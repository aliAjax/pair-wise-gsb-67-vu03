import type {
  AcceptanceDefect,
  ChainBlocker,
  EquipmentNode,
  NodeChainState,
  Plant,
  ReleasePermit
} from '../types/domain'

function certBlockersForNode(node: EquipmentNode, commissioningDate: string): ChainBlocker[] {
  const list: ChainBlocker[] = []
  for (const cert of node.certificates) {
    let status: string | null = null
    let detail = ''
    const editionConfirmed = cert.confirmedVersion === undefined || cert.confirmedVersion === cert.version
    if (!cert.verified) { status = '未核验'; detail = `${cert.name}（${cert.issuer}）尚未核验` }
    else if (!editionConfirmed) { status = '换版待确认'; detail = `${cert.name}已换版至V${cert.version}，已确认版次仍为V${cert.confirmedVersion}` }
    else if (cert.expiresAt < commissioningDate) { status = '已过期'; detail = `${cert.name}有效期至${cert.expiresAt}，早于并网日期${commissioningDate}` }
    if (status) list.push({
      key: `cert:${cert.id}`,
      fingerprint: `证书:${cert.id}:V${cert.version}:确认V${cert.confirmedVersion ?? cert.version}:${cert.verified ? 1 : 0}:${cert.expiresAt}:${status}`,
      kind: '证书', sourceId: cert.id, equipmentId: node.id, equipmentName: node.name,
      title: cert.name, detail, severity: '重大', status
    })
  }
  // 汇流箱/逆变器至少应具备一份证书附件，缺失即阻断
  if ((node.type === '汇流箱' || node.type === '逆变器') && node.certificates.length === 0) {
    list.push({
      key: `cert:missing:${node.id}`,
      fingerprint: `证书:missing:${node.id}`,
      kind: '证书', sourceId: `missing-${node.id}`, equipmentId: node.id, equipmentName: node.name,
      title: `${node.type}证书缺失`, detail: `${node.name}未挂接任何型式试验/并网认证证书`, severity: '重大', status: '缺证书'
    })
  }
  return list
}

function itemBlocker(node: EquipmentNode, item: EquipmentNode['items'][number], openDefects: Map<string, AcceptanceDefect>): ChainBlocker | null {
  const defect = openDefects.get(item.id)
  // 缺陷重新打开：无论验收项当前结果如何，重新成为阻断依据
  if (defect?.status === '重新打开') {
    return {
      key: `item:${item.id}`,
      fingerprint: `验收项:${item.id}:V${item.version}:重新打开:D${defect.version}`,
      kind: '验收项', sourceId: item.id, equipmentId: node.id, equipmentName: node.name,
      title: item.standard,
      detail: `缺陷${defect.id}重新打开（${defect.title}）；原实测：${item.measured || '无记录'}`,
      severity: defect.severity === '重大' ? '重大' : '一般',
      status: '重新打开'
    }
  }
  if (item.status === '合格') return null
  const detailParts = [`实测：${item.measured || '无记录'}`]
  if (!item.evidence) detailParts.push('缺少测试证据')
  if (defect) detailParts.push(`缺陷${defect.id}（${defect.status}）`)
  return {
    key: `item:${item.id}`,
    fingerprint: `验收项:${item.id}:V${item.version}:${item.status}:${item.measured}`,
    kind: '验收项', sourceId: item.id, equipmentId: node.id, equipmentName: node.name,
    title: item.standard, detail: detailParts.join('；'), severity: defect?.severity === '重大' || item.status === '不合格' ? '重大' : '一般',
    status: item.status
  }
}

/** 设备树层级类型顺序，用于旧数据补齐父级关系 */
const TYPE_ORDER: EquipmentNode['type'][] = ['并网点', '变压器', '方阵', '逆变器', '汇流箱']

export interface HierarchyRepairInput {
  nodeId: string
  oldParentId: string | null
  newParentId: string | null
  newParentName: string
  reason: string
}

/**
 * 按现有节点层级补齐缺失的父级关系。
 * 规则：parentId 为空/指向不存在节点/形成环时，挂到“类型上一级”的最后一个节点；
 * 同级存在多个时选择当前排布中最接近的前一个同级。
 */
export function repairHierarchy(equipment: EquipmentNode[]): { nodes: EquipmentNode[]; repairs: HierarchyRepairInput[] } {
  const nodes = structuredClone(equipment)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const repairs: HierarchyRepairInput[] = []

  const reachesCycle = (node: EquipmentNode): boolean => {
    const seen = new Set<string>()
    let cur: EquipmentNode | undefined = node
    while (cur && cur.parentId) {
      if (seen.has(cur.id)) return true
      seen.add(cur.id)
      cur = byId.get(cur.parentId)
    }
    return false
  }

  nodes.forEach((node, index) => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    const invalidRef = !!node.parentId && !parent
    const cyclic = reachesCycle(node)
    // 并网点应为根：引用缺失或成环时直接恢复为根
    if (node.type === '并网点') {
      if (node.parentId && (invalidRef || cyclic)) {
        const old = node.parentId
        node.parentId = null
        repairs.push({
          nodeId: node.id, oldParentId: old, newParentId: '', newParentName: '（根节点）',
          reason: invalidRef ? `原父级${old}不存在` : '原父级关系成环，并网点恢复为根'
        })
      }
      return
    }
    const needsRepair = !node.parentId || invalidRef || cyclic
    if (!needsRepair) return
    const parentType = TYPE_ORDER[TYPE_ORDER.indexOf(node.type) - 1]
    // 从当前位置向前找最近的上一级类型节点；找不到则取该类型任意节点
    let target = nodes.slice(0, index).reverse().find((n) => n.type === parentType)
    if (!target) target = nodes.find((n) => n.type === parentType)
    if (!target) return
    const old = node.parentId
    node.parentId = target.id
    repairs.push({
      nodeId: node.id, oldParentId: old, newParentId: target.id, newParentName: target.name,
      reason: old && !parent ? `原父级${old}不存在` : reachesCycle({ ...node, parentId: old }) ? '原父级关系成环' : '缺少父级关系，按设备层级补齐'
    })
  })
  return { nodes, repairs }
}

function dedupeBlockers(list: ChainBlocker[]): ChainBlocker[] {
  const map = new Map<string, ChainBlocker>()
  for (const b of list) if (!map.has(b.key)) map.set(b.key, b)
  return [...map.values()]
}

export interface ChainTree {
  roots: EquipmentNode[]
  children: Map<string, EquipmentNode[]>
  byId: Map<string, EquipmentNode>
}

export function buildTree(equipment: EquipmentNode[]): ChainTree {
  const byId = new Map(equipment.map((n) => [n.id, n]))
  const children = new Map<string, EquipmentNode[]>()
  const roots: EquipmentNode[] = []
  // 保持数据中的既有排布顺序
  for (const node of equipment) {
    if (node.parentId && byId.has(node.parentId)) {
      const list = children.get(node.parentId) ?? []
      list.push(node)
      children.set(node.parentId, list)
    }
    else roots.push(node)
  }
  return { roots, children, byId }
}

/**
 * 自底向上逐级重算整棵放行链：
 * 每个节点合并本节点依据（证书/验收项/开放缺陷）与全部子树依据，
 * 再与最近一张有效放行单比对指纹，得出链状态。
 */
export function recomputeChain(
  equipment: EquipmentNode[],
  defects: AcceptanceDefect[],
  permits: ReleasePermit[],
  plant: Plant
): Map<string, NodeChainState> {
  const tree = buildTree(equipment)
  const openDefectsByItem = new Map<string, AcceptanceDefect>()
  for (const d of defects) {
    if (d.status !== '已关闭') openDefectsByItem.set(d.itemId, d)
  }
  // 每个分支根只保留最近一张未撤销的有效单
  const latestPermit = new Map<string, ReleasePermit>()
  for (const p of permits) {
    if (p.status === 'revoked') continue
    const cur = latestPermit.get(p.branchRootId)
    if (!cur || p.issuedAt > cur.issuedAt) latestPermit.set(p.branchRootId, p)
  }

  const states = new Map<string, NodeChainState>()

  // 本节点自身依据（证书/缺证/验收项+开放缺陷），先序遍历与合并共用
  const ownCache = new Map<string, ChainBlocker[]>()
  function ownOf(n: EquipmentNode): ChainBlocker[] {
    if (!ownCache.has(n.id)) {
      const list: ChainBlocker[] = []
      list.push(...certBlockersForNode(n, plant.commissioningDate))
      for (const item of n.items) { const b = itemBlocker(n, item, openDefectsByItem); if (b) list.push(b) }
      ownCache.set(n.id, list)
    }
    return ownCache.get(n.id)!
  }

  // 放行单沿父链下传：子节点未自带放行单时继承最近祖先分支单
  const evaluate = (node: EquipmentNode, depth: number, inheritedPermit: ReleasePermit | null = null, inheritedRoot: string | null = null): ChainBlocker[] => {
    const own = ownOf(node)
    const kids = tree.children.get(node.id) ?? []
    // 本节点自带放行单时，下传它；否则继承祖先分支单
    const mine = latestPermit.get(node.id) ?? null
    const permit = mine ?? inheritedPermit
    const permitRootId = mine ? node.id : inheritedRoot
    const sub: ChainBlocker[] = []
    for (const kid of kids) sub.push(...evaluate(kid, depth + 1, permit, permitRootId))

    const merged = dedupeBlockers([...own, ...sub])

    // 全局先序编号（每节点内部重大优先），再按“重大优先 → 先序”确定最先出问题的依据
    const orderIndex = new Map<string, number>()
    let seq = 0
    const rank = (b: ChainBlocker) => (b.severity === '重大' ? 0 : 1)
    const numbering = (n: EquipmentNode) => {
      for (const b of [...ownOf(n)].sort((a, b2) => rank(a) - rank(b2))) orderIndex.set(b.key, seq++)
      for (const k of tree.children.get(n.id) ?? []) numbering(k)
    }
    numbering(node)
    merged.sort((a, b2) => rank(a) - rank(b2) || (orderIndex.get(a.key)! - orderIndex.get(b2.key)!))
    const first = merged[0] ?? null
    let firstProblemChildId: string | null = null
    if (first && first.equipmentId !== node.id) {
      let cur = tree.byId.get(first.equipmentId)
      while (cur && cur.parentId !== node.id) cur = cur?.parentId ? tree.byId.get(cur.parentId) : undefined
      firstProblemChildId = cur?.id ?? null
    }

    const currentFp = new Set(merged.map((b) => b.fingerprint))
    let status: NodeChainState['status'] = merged.length ? '阻断' : '无阻断'
    if (permit) {
      const basisFp = new Set(permit.basis.fingerprints)
      const unchanged = merged.every((b) => basisFp.has(b.fingerprint)) && permit.basis.fingerprints.every((f) => currentFp.has(f))
      status = merged.length === 0
        ? (permit.kind === 'formal' ? '正式放行' : '无阻断')
        : unchanged
          ? '临时放行'
          : '放行失效'
    }
    else if (merged.length === 0) {
      status = '正式放行'
    }

    states.set(node.id, {
      nodeId: node.id, blockers: merged, ownBlockerCount: own.length,
      firstBlocker: first, firstProblemChildId, status,
      permitId: permit?.id ?? null, permitRootId, depth
    })
    return merged
  }

  for (const root of tree.roots) evaluate(root, 0)
  return states
}

/** 比较放行单依据与当前子树依据，返回新增/解除明细 */
export function diffBasis(permit: ReleasePermit, state: NodeChainState | null) {
  const current = state?.blockers ?? []
  const currentMap = new Map(current.map((b) => [b.fingerprint, b]))
  const added = current.filter((b) => !permit.basis.fingerprints.includes(b.fingerprint)).map((b) => `${b.equipmentName} · ${b.title}（${b.status}）`)
  const removed = permit.basis.labels.filter((_, i) => !currentMap.has(permit.basis.fingerprints[i]))
  return { added, removed }
}
