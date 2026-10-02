export type InspectionStatus = '待检查' | '合格' | '不合格' | '待复验'
export type DefectStatus = '待分派' | '整改中' | '待联合复验' | '已关闭' | '带条件通过' | '重新打开'
export type Party = '建设单位' | '设备厂家' | '运维单位'

export interface AcceptanceItem {
  id: string
  standard: string
  method: string
  condition: string
  status: InspectionStatus
  measured: string
  evidence: string
  version: number
}

export interface Certificate {
  id: string
  name: string
  issuer: string
  expiresAt: string
  version: number
  verified: boolean
  /** 已确认的证书版次：换版后 version 增长而本值停留旧版，即“换版待确认”依据 */
  confirmedVersion?: number
}

export interface EquipmentNode {
  id: string
  parentId: string | null
  name: string
  type: '并网点' | '变压器' | '方阵' | '逆变器' | '汇流箱'
  code: string
  status: '待验收' | '验收中' | '已验收'
  items: AcceptanceItem[]
  certificates: Certificate[]
}

export interface PartyReply {
  party: Party
  owner: string
  content: string
  evidence: string
  repliedAt: string
}

export interface AcceptanceDefect {
  id: string
  equipmentId: string
  itemId: string
  title: string
  severity: '一般' | '重大'
  status: DefectStatus
  owner: string
  dueDate: string
  replies: PartyReply[]
  retests: Array<{ round: number; passed: boolean; result: string; tester: string; testedAt: string }>
  decisionNote: string
  version: number
}

export interface Plant {
  id: string
  name: string
  gridPoint: string
  capacity: string
  commissioningDate: string
  status: '验收中' | '待复核' | '已签署'
  version: number
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

// ===== 树形放行链 =====

export type BlockerKind = '验收项' | '证书' | '缺陷' | '验收进度'
export type ChainStatus = '无阻断' | '阻断' | '临时放行' | '正式放行' | '放行失效'

/** 链上的一条阻断依据（证书缺失/换版、验收项结果、开放缺陷、未完成检查） */
export interface ChainBlocker {
  /** 同一来源稳定标识，用于合并 */
  key: string
  /** 随状态/版本变化的指纹，用于放行单依据比对 */
  fingerprint: string
  kind: BlockerKind
  sourceId: string
  equipmentId: string
  equipmentName: string
  /** 依据标题，如验收标准或证书名称 */
  title: string
  /** 实测值或问题说明 */
  detail: string
  severity: '重大' | '一般'
  /** 不合格 / 待复验 / 缺证书 / 未核验 / 已过期 / 重新打开 / 待检查 */
  status: string
}

export interface NodeChainState {
  nodeId: string
  /** 本节点及整棵子树合并后的全部阻断依据（重大在前，子树按设备顺序） */
  blockers: ChainBlocker[]
  ownBlockerCount: number
  /** 沿设备顺序深度优先找到的第一条阻断依据 */
  firstBlocker: ChainBlocker | null
  /** 第一条阻断依据所在的子节点；落在本节点时为 null */
  firstProblemChildId: string | null
  status: ChainStatus
  /** 实际覆盖本节点的放行单（最近的一张，可能挂在祖先分支根上） */
  permitId: string | null
  /** 放行单挂载的分支根节点 */
  permitRootId: string | null
  depth: number
}

export type PermitStatus = 'active' | 'paused' | 'revoked'
export type PermitKind = 'temporary' | 'formal'

export interface PermitBasis {
  /** 签发/重新确认时子树全部阻断依据的指纹 */
  fingerprints: string[]
  /** 与指纹一一对应的可读依据，用于页面展示与比对 */
  labels: string[]
}

/** 分支临时放行单：挂在某个分支根（设备节点）上，覆盖其整棵子树 */
export interface ReleasePermit {
  id: string
  branchRootId: string
  branchRootName: string
  applicant: string
  reason: string
  kind: PermitKind
  status: PermitStatus
  basis: PermitBasis
  issuedAt: string
  reconfirmedAt: string | null
  /** 依据变化后立即失效的原因与时间 */
  invalidatedAt: string | null
  invalidateReason: string
  /** 失效时新增的依据（如新出现的不合格项） */
  basisAdded: string[]
  /** 失效时已解除的依据（如缺陷已整改） */
  basisRemoved: string[]
  revokedAt: string | null
  version: number
}

/** 每次变更前留存的最后完整树快照，写入失败或人工回滚时使用 */
export interface TreeSnapshot {
  id: string
  takenAt: string
  trigger: string
  operator: string
  digest: string
  plant: Plant
  equipment: EquipmentNode[]
  defects: AcceptanceDefect[]
  permits: ReleasePermit[]
}

/** 旧数据父级关系补齐记录 */
export interface HierarchyRepair {
  id: string
  nodeId: string
  nodeName: string
  oldParentId: string | null
  newParentId: string | null
  newParentName: string
  reason: string
  at: string
}

export interface RecoveryNote {
  at: string
  snapshotId: string
  trigger: string
  detail: string
}
