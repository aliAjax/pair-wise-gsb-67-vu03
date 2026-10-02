export type InspectionStatus = '待检查' | '合格' | '不合格' | '待复验'
export type DefectStatus = '待分派' | '整改中' | '待联合复验' | '已关闭' | '带条件通过'
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

export type PassState = '临时放行中' | '待确认' | '已续期' | '正式放行' | '已失效'

export interface PassHistoryEntry {
  at: string
  action: string
  operator: string
  detail: string
}

export interface ChangedSource {
  key: string
  title: string
  before: string
  after: string
}

export interface ReleasePass {
  id: string
  branchRootId: string
  branchName: string
  owner: string
  reason: string
  issuedAt: string
  state: PassState
  /** 签发时分支子树全部依据的版本/状态指纹 */
  signatures: Record<string, string>
  treeVersion: number
  changedSources?: ChangedSource[]
  invalidatedAt?: string
  invalidBasis?: FirstProblem
  history: PassHistoryEntry[]
}

export interface RepairNote {
  nodeId: string
  nodeName: string
  oldParentId: string | null
  newParentId: string | null
  reason: string
  repairedAt: string
}

export type ChainState = 'pass' | 'temp' | 'block'
export type ReasonKind = '验收项' | '证书' | '缺陷'

export interface ChainReason {
  kind: ReasonKind
  sourceId: string
  nodeId: string
  title: string
  detail: string
  version: number
  state: ChainState
}

export interface FirstProblem {
  nodeId: string
  nodeName: string
  /** 从分支根到问题节点的完整路径 */
  path: string[]
  reason: ChainReason
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
