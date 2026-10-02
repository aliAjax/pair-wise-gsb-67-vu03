import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url)
const { recomputeChain, repairHierarchy } = await jiti.import('../services/chain.ts')
const seed = await jiti.import('../data/seed.ts')

let pass = 0, fail = 0
function check(name, cond) { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }

// 1) 旧数据父级补齐
const repaired = repairHierarchy(seed.seedEquipment)
const cb122 = repaired.nodes.find(n => n.id === 'EQ-CB122')
check('旧节点 EQ-CB122 补齐父级到 EQ-INV12', cb122.parentId === 'EQ-INV12')
check('生成一条补齐记录', repaired.repairs.some(r => r.nodeId === 'EQ-CB122'))
// 父级不存在 / 成环
const messy = JSON.parse(JSON.stringify(seed.seedEquipment)).filter(n => n.id !== 'EQ-CB122')
messy.push({ id: 'EQ-X', parentId: null, name: '孤岛汇流箱', type: '汇流箱', code: 'X', status: '待验收', items: [], certificates: [] })
messy[0].parentId = 'EQ-AR1' // 并网点被错误挂到方阵 -> 会成环
const r2 = repairHierarchy(messy)
check('成环父级被修复（并网点重新成为根）', r2.nodes.find(n => n.type === '并网点').parentId === null)

// 2) 初始链：根节点阻断，最先问题定位
let states = recomputeChain(repaired.nodes, seed.seedDefects, [], seed.seedPlant)
const root = states.get('EQ-GRID')
check('根节点阻断', root.status === '阻断')
check('根最先问题子节点为变压器(主变 IT-T2 重大)', root.firstProblemChildId === 'EQ-TR1')
check('根阻断依据包含证书/验收项/缺陷', root.blockers.length >= 4)
check('汇流箱缺证/未核验入链', root.blockers.some(b => b.sourceId === 'C-C1' && b.status === '未核验'))
// INV12/CB121/CB122 干净分支
check('干净逆变器无阻断', states.get('EQ-INV12').status === '正式放行')

// 3) 签发主变分支放行单：主变及其父（根）临时放行
const trState = states.get('EQ-TR1')
const permit = {
  id: 'RP-1', branchRootId: 'EQ-TR1', branchRootName: '1号主变压器', applicant: '陆川', reason: '测试',
  kind: 'temporary', status: 'active',
  basis: { fingerprints: trState.blockers.map(b => b.fingerprint), labels: trState.blockers.map(b => b.id) },
  issuedAt: '2026-10-01T10:00:00', reconfirmedAt: null, invalidatedAt: null, invalidateReason: '',
  basisAdded: [], basisRemoved: [], revokedAt: null, version: 1
}
states = recomputeChain(repaired.nodes, seed.seedDefects, [permit], seed.seedPlant)
check('主变节点临时放行', states.get('EQ-TR1').status === '临时放行')
check('主变放行单下传至方阵', states.get('EQ-AR1').permitRootId === 'EQ-TR1')
check('根节点仍为阻断（并网点自身 IT-G2 未覆盖）', states.get('EQ-GRID').status === '阻断')

// 4) 证书换版（version+1 但已确认版次停留旧值）=> 放行失效
const swapped = JSON.parse(JSON.stringify(repaired.nodes))
const cert = swapped.find(n => n.id === 'EQ-INV11').certificates[0]
cert.version += 1
cert.confirmedVersion = cert.version - 1
states = recomputeChain(swapped, seed.seedDefects, [permit], seed.seedPlant)
check('证书换版后主变放行失效', states.get('EQ-TR1').status === '放行失效')
check('出现换版待确认依据', states.get('EQ-INV11').blockers.some(b => b.status === '换版待确认'))
// 确认新版后依据解除
const confirmed = JSON.parse(JSON.stringify(swapped))
confirmed.find(n => n.id === 'EQ-INV11').certificates[0].confirmedVersion = cert.version
states = recomputeChain(confirmed, seed.seedDefects, [permit], seed.seedPlant)
check('确认新版后该证书依据解除', !states.get('EQ-INV11').blockers.some(b => b.sourceId === 'C-I1'))

// 5) 验收项结果变化 => 放行失效
const changed = JSON.parse(JSON.stringify(repaired.nodes))
changed.find(n => n.id === 'EQ-INV11').items.find(i => i.id === 'IT-I2').status = '不合格'
changed.find(n => n.id === 'EQ-INV11').items.find(i => i.id === 'IT-I2').version += 1
states = recomputeChain(changed, seed.seedDefects, [permit], seed.seedPlant)
check('验收项结果变化后放行失效', states.get('EQ-TR1').status === '放行失效')

// 6) 问题解除（全部子树依据清空）依据集为空 => 无阻断，原单需重新确认
const cleaned = JSON.parse(JSON.stringify(repaired.nodes))
const closedDefs = JSON.parse(JSON.stringify(seed.seedDefects)).map(d => ({ ...d, status: '已关闭' }))
for (const n of cleaned) {
  n.items = n.items.map(i => ({ ...i, status: '合格', measured: i.measured || '正常' }))
  for (const c of n.certificates) c.verified = true
}
states = recomputeChain(cleaned, closedDefs, [permit], seed.seedPlant)
check('子项全部解决后主变无阻断', states.get('EQ-TR1').status === '无阻断')

// 7) 缺陷重新打开 => 关联项重新阻断
const reopenedDefs = JSON.parse(JSON.stringify(closedDefs))
reopenedDefs[0].status = '重新打开'
states = recomputeChain(cleaned, reopenedDefs, [], seed.seedPlant)
check('缺陷重开后根节点阻断', states.get('EQ-GRID').status === '阻断')
check('重开依据状态为重新打开', states.get('EQ-GRID').blockers.some(b => b.status === '重新打开'))

// 8) 同分支两张单只保留最新一张
const p2 = { ...permit, id: 'RP-2', issuedAt: '2026-10-02T09:00:00', basis: permit.basis }
states = recomputeChain(repaired.nodes, seed.seedDefects, [permit, p2], seed.seedPlant)
check('同分支重复申请时只保留最新一张', states.get('EQ-TR1').permitId === 'RP-2')

// 9) 缺证书判定
const noCert = JSON.parse(JSON.stringify(cleaned)).filter(n => ['EQ-GRID', 'EQ-TR1', 'EQ-AR1', 'EQ-INV11'].includes(n.id))
noCert.find(n => n.id === 'EQ-INV11').certificates = []
states = recomputeChain(noCert, closedDefs, [], seed.seedPlant)
check('逆变器缺证书构成阻断', states.get('EQ-INV11').blockers.some(b => b.status === '缺证书'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
