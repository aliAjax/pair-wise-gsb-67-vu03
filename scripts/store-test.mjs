// Store 级集成验证：快照事务、失败回滚、放行单并发去重与自动失效
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url, { alias: { '#app': './scripts/stubs/app.mjs', '#imports': './scripts/stubs/imports.mjs' } })
const { createPinia, setActivePinia } = await jiti.import('pinia')

// Node 的 structuredClone 无法克隆 Vue 响应式代理（浏览器不受影响），测试中改用 JSON 深克隆
globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v))
// 最小 localStorage 桩
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear()
}
// 模拟浏览器环境，store 用 import.meta.client 决定持久化
globalThis.window = globalThis
globalThis.__GSB_FORCE_CLIENT__ = true

setActivePinia(createPinia())
const { useAcceptanceStore } = await jiti.import('../stores/acceptance.ts')
const store = useAcceptanceStore()

let pass = 0, fail = 0
const check = (name, cond) => { cond ? pass++ : fail++; console.log(cond ? 'PASS' : 'FAIL', name) }

// --- 场景 A：正常写入生成快照 ---
const before = store.equipment.length
const r1 = store.updateItem('EQ-TR1', 'IT-T1', { status: '合格' })
check('正常写入成功', r1.ok)
check('变更前留存完整树快照', store.snapshots.length >= 1 && store.snapshots[0].trigger === '验收项结果变化')
const afterSnap = JSON.parse(mem.get('gsb67:grid-acceptance'))
check('快照已持久化', afterSnap.snapshots.length >= 1)

// --- 场景 B：写入中途失败，从最后完整树快照恢复 ---
const beforePlantVersion = store.plant.version
const beforeDefectVersion = store.defects.find(d => d.id === 'AD-260929-01').version
store.armFailure()
const r2 = store.assignDefect('AD-260929-01', '运维单位')
check('失败写入返回失败', !r2.ok && /快照/.test(r2.message))
check('内存状态已回滚（责任方不变）', store.defects.find(d => d.id === 'AD-260929-01').owner === '设备厂家')
check('内存状态已回滚（缺陷版本不变）', store.defects.find(d => d.id === 'AD-260929-01').version === beforeDefectVersion)
const persisted = JSON.parse(mem.get('gsb67:grid-acceptance'))
check('持久化也恢复到最后完整树', persisted.defects.find(d => d.id === 'AD-260929-01').owner === '设备厂家')
check('记录恢复说明', store.recoveryNotes[0]?.detail.includes('写入中途失败'))
check('审计记录快照恢复动作', store.audit.some(a => a.action === '快照恢复'))

// --- 场景 C：两个负责人为同一分支申请放行只保留一张有效单 ---
const applied1 = store.applyPermit('EQ-AR1', '负责人甲', '方阵临时放行')
check('甲申请成功', applied1.ok)
const permitId = store.branchPermit('EQ-AR1').id
const applied2 = store.applyPermit('EQ-AR1', '负责人乙', '重复申请')
check('乙对同一分支的重复申请被拒绝', !applied2.ok && /只保留一张/.test(applied2.message))
check('同分支仍只有甲那张有效单', store.branchPermit('EQ-AR1').id === permitId && store.branchPermit('EQ-AR1').applicant === '负责人甲')

// --- 场景 D：证书换版后放行单立即失效（逐级）---
const certRes = store.updateCertificate('EQ-INV11', 'C-I1', {})
check('证书换版成功', certRes.ok)
const permitAfter = store.permits.find(p => p.id === permitId)
check('方阵放行单立即失效', permitAfter.status === 'paused')
check('失效单记录新增依据', permitAfter.basisAdded.some(s => s.includes('换版待确认')))
check('链状态显示放行失效', store.nodeState('EQ-AR1').status === '放行失效')
check('上游主变/并网点逐级重算', ['阻断', '放行失效'].includes(store.nodeState('EQ-TR1').status))

// --- 场景 E：确认新版后重新确认，原临时放行继续 ---
store.confirmCertificateEdition('EQ-INV11', 'C-I1')
const reconf = store.reconfirmPermit(permitId, '负责人甲', '换版已确认')
check('重新确认成功', reconf.ok)
const permitRe = store.permits.find(p => p.id === permitId)
check('原放行单恢复有效（同一单号继续）', permitRe.status === 'active' && permitRe.version >= 2)
check('重新确认时间已记录', !!permitRe.reconfirmedAt)

// --- 场景 F：缺陷重新打开导致已重新确认的放行再次失效（须使用方阵子树内缺陷 AD-260929-02@INV11）---
store.decideDefect('AD-260929-02', '带条件通过', '限定功率运行')
const reopenRes = store.reopenDefect('AD-260929-02', '现场复核效率再次不达标')
check('子树内缺陷可重新打开', reopenRes.ok)
const permitAfterReopen = store.permits.find(p => p.id === permitId)
check('缺陷重开后方阵放行再次失效', permitAfterReopen.status === 'paused')
check('失效原因指向重新打开', permitAfterReopen.basisAdded.some(s => s.includes('重新打开')) || permitAfterReopen.invalidateReason.includes('重新打开'))

// --- 场景 G：人工恢复快照 ---
const snapId = store.snapshots[0].id
const restore = store.restoreSnapshot(snapId)
check('快照可人工恢复', restore.ok)
check('篡改摘要的快照拒绝恢复', (() => {
  store.snapshots[0].plant.name = 'HACKED'
  const r = store.restoreSnapshot(store.snapshots[0].id)
  return !r.ok && /摘要/.test(r.message)
})())

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
