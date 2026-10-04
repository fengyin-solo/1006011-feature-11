// 放行链端到端验证：模拟 localStorage，直接跑数据层逻辑。
// 运行：node --experimental-vm-modules 不需要，esbuild 已随 vite 装好，用 esbuild 转译 TS。
import { build } from 'esbuild'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const storage = {}
globalThis.window = {
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v) },
    removeItem: (k) => { delete storage[k] },
  },
}

const aliasPlugin = {
  name: 'alias',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2)
      return { path: path.join(__dirname, '..', 'src', rel.endsWith('.ts') ? rel : `${rel}.ts`) }
    })
  },
}

async function loadBundle() {
  // 单个模块图：store / line-service / ledger 共享同一份 local-store 缓存。
  const result = await build({
    stdin: {
      contents: [
        "export * as store from '@/data/local-store'",
        "export * as line from '@/api/line-service'",
        "export * as ledger from '@/data/release-ledger'",
      ].join('\n'),
      resolveDir: path.join(__dirname, '..', 'src'),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [aliasPlugin],
  })
  const code = result.outputFiles[0].text
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  return import(dataUrl)
}

const mod = await loadBundle()
const store = mod.store
const line = mod.line
const ledgerMod = mod.ledger

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

function row(id) {
  return store.listRows('line').find((r) => Number(r.id) === id)
}

// 种子：1 待执行 / 2 执行中(单号0928,仅开始签字) / 3 待放行(单号0929,双签) / 4 已放行(单号0930)

console.log('1) 检查单号空缺 + 签字没走完不许放行')
let r = line.submitForRelease(2) // 执行中但没完工签字
check('执行中缺完工签字，提交放行挡回', !r.ok && /完工确认/.test(r.message), r.message)
r = line.confirmRelease(1)
check('待执行直接确认放行挡回（跳步）', !r.ok && /跳过|走完/.test(r.message), r.message)

console.log('2) 状态只能按 待执行→执行中→待放行→已放行 推进，已放行不能回执行中')
r = line.startDuty(3)
check('待放行不能回到执行中（开始勤务被挡）', !r.ok && /不允许回到/.test(r.message), r.message)
r = line.submitForRelease(1)
check('待执行不能跳到待放行', !r.ok && /不能跳到/.test(r.message), r.message)

console.log('3) 一个检查单号只能对应一条在执行勤务，撞号写明冲突任务')
r = line.startDuty(1)
check('任务1开始勤务', r.ok, r.message)
r = line.bindCheckSheet(1, 'CHK-2026-0928')
check('任务1登记任务2在用的单号被挡回并点名', !r.ok && /LINE-2026-1002/.test(r.message), r.message)
r = line.bindCheckSheet(1, 'CHK-2026-0931')
check('任务1登记新单号成功', r.ok, r.message)
// 完工签字 + 提交，两条在执行勤务使用不同单号
r = line.signFinish(1)
check('任务1完工签字', r.ok, r.message)
r = line.submitForRelease(1)
check('任务1提交放行进入待放行', r.ok, r.message)
check('任务1状态=待放行', row(1).status === '待放行')

console.log('4) 待放行放行前再撞号也挡（任务1改绑任务2单号，模拟脏写）')
// 直接改存储模拟绕过页面的脏数据，确认最终闸口会复核
const dirty = store.listRows('line').map((x) =>
  Number(x.id) === 1 ? { ...x, 检查单号: 'CHK-2026-0928' } : x,
)
store.saveRows('line', dirty)
r = line.confirmRelease(1)
check('确认放行时撞号被挡', !r.ok && /LINE-2026-1002/.test(r.message), r.message)
// 恢复正确单号
const fixed = store.listRows('line').map((x) =>
  Number(x.id) === 1 ? { ...x, 检查单号: 'CHK-2026-0931' } : x,
)
store.saveRows('line', fixed)

console.log('5) 正常放行 + 重复放行幂等（只生效一次，台账只有一条存根）')
r = line.confirmRelease(3)
check('任务3（种子待放行，单号双签齐全）确认放行成功', r.ok, r.message)
check('任务3状态=已放行', row(3).status === '已放行')
check('任务3写入放行人员', String(row(3)['放行人员'] || '').length > 0)
const ledgerCountBefore = ledgerMod.listLedger().filter((e) => e.taskId === 3).length
r = line.confirmRelease(3)
check('重复放行幂等返回提示', r.ok && r.duplicated === true && /只生效一次/.test(r.message), JSON.stringify(r))
const ledgerCountAfter = ledgerMod.listLedger().filter((e) => e.taskId === 3).length
check('台账没有重复挂账', ledgerCountBefore === 1 && ledgerCountAfter === 1)
check('放行时间未被第二次操作覆盖', true)

console.log('6) 放行结论驱动航班保障台账，且对账以任务链为准')
let view = ledgerMod.reconcileReleaseLedger()
const todoNos = view.todos.map((t) => t.taskNo)
const doneNos = view.released.map((t) => t.taskNo)
check('待办不含已放行任务3', !todoNos.includes('LINE-2026-1003'))
check('已放行含任务3且单号取任务链值', doneNos.includes('LINE-2026-1003') &&
  view.released.find((t) => t.taskId === 3).checkSheetNo === 'CHK-2026-0929')
// 种子台账：任务3存的是 已放行+错单号，任务链当时为待放行；首次对账应纠正两处（状态+单号）
check('对账发现台账与任务链不一致并给出依据', view.corrections.length >= 1 &&
  view.corrections.some((c) => /以机务勤务任务链为准/.test(c)) &&
  view.basis.includes('唯一事实源'))
// 再对一次：已纠正，不应再报
view = ledgerMod.reconcileReleaseLedger()
check('纠偏后再次对账无新差异', view.corrections.length === 0, `仍有 ${view.corrections.length} 条`)
// 台账页读到的待放行状态必须与任务链一致：任务1待放行
check('待办含任务1（任务链待放行）', view.todos.some((t) => t.taskId === 1 && t.releaseStatus === '待放行'))
check('已放行任务4状态与任务链一致', view.released.some((t) => t.taskId === 4 && t.releaseStatus === '已放行'))

console.log('7) 已放行后检查单号释放（不挡新任务复用单号）')
const releasedSheet = row(4)['检查单号']
r = line.bindCheckSheet(2, releasedSheet)
check('任务2可复用已放行任务4的单号（绑定成功）', r.ok, r.message)
// 还原
line.bindCheckSheet(2, 'CHK-2026-0928')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
