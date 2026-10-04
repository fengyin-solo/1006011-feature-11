import { beforeEach, describe, expect, it } from 'vitest'

import {
  flightReleaseLedger,
  isEffectiveRelease,
  nextLineAction,
  reconcileLineRelease,
  runLineAction,
} from '@/api/line-release'
import { allowedActions, listEntries, runAction } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 数据层在 node 里没有 window，走内存缓存；每个用例用 saveRows 整体重铺，互不影响。
function lineRow(id: number, status: string, checkNo: string, flightNo = 'CA1501'): EntryRow {
  return {
    id,
    status,
    pending: status !== '已放行',
    abnormal: false,
    任务编号: `LINE-${String(id).padStart(4, '0')}`,
    航班号: flightNo,
    检查单号: checkNo,
  }
}

function flightRow(id: number, flightNo: string): EntryRow {
  return { id, status: '保障中', pending: true, abnormal: false, 保障编号: `FLIG-${id}`, 航班号: flightNo }
}

function lineStatus(id: number): string {
  const row = listRows('line').find((item) => Number(item.id) === id)
  return String(row?.status)
}

beforeEach(() => {
  saveRows('line', [])
  saveRows('flight', [])
})

describe('勤务状态链', () => {
  it('按 待执行→执行中→待放行→已放行 逐级推进', () => {
    saveRows('line', [lineRow(1, '待执行', 'CHK-1')])
    expect(runLineAction(1, '开始勤务').ok).toBe(true)
    expect(lineStatus(1)).toBe('执行中')
    expect(runLineAction(1, '提交放行').ok).toBe(true)
    expect(lineStatus(1)).toBe('待放行')
    expect(runLineAction(1, '确认放行').ok).toBe(true)
    expect(lineStatus(1)).toBe('已放行')
  })

  it('跳步一律挡回：没走到上一步不许点后面的动作', () => {
    saveRows('line', [lineRow(1, '待执行', 'CHK-1'), lineRow(2, '执行中', 'CHK-2')])
    const skipSubmit = runLineAction(1, '提交放行')
    expect(skipSubmit.ok).toBe(false)
    expect(skipSubmit.message).toContain('逐级推进')
    const skipConfirm = runLineAction(1, '确认放行')
    expect(skipConfirm.ok).toBe(false)
    const jumpRelease = runLineAction(2, '确认放行')
    expect(jumpRelease.ok).toBe(false)
    expect(lineStatus(1)).toBe('待执行')
    expect(lineStatus(2)).toBe('执行中')
  })

  it('已放行不允许回到执行中', () => {
    saveRows('line', [lineRow(1, '已放行', 'CHK-1')])
    const result = runLineAction(1, '开始勤务')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('不允许回到执行中')
    expect(lineStatus(1)).toBe('已放行')
  })

  it('同一条任务重复放行只生效一次', () => {
    saveRows('line', [lineRow(1, '待放行', 'CHK-1')])
    expect(runLineAction(1, '确认放行').ok).toBe(true)
    const again = runLineAction(1, '确认放行')
    expect(again.ok).toBe(true)
    expect(again.message).toContain('不重复生效')
    expect(lineStatus(1)).toBe('已放行')
  })

  it('未登记的动作直接拒绝', () => {
    saveRows('line', [lineRow(1, '待执行', 'CHK-1')])
    expect(runLineAction(1, '随便点点').ok).toBe(false)
  })
})

describe('检查单号', () => {
  it('检查单号空缺不许提交放行，也不许确认放行', () => {
    saveRows('line', [lineRow(1, '执行中', ''), lineRow(2, '待放行', '  ')])
    const submit = runLineAction(1, '提交放行')
    expect(submit.ok).toBe(false)
    expect(submit.message).toContain('检查单号空缺')
    const confirm = runLineAction(2, '确认放行')
    expect(confirm.ok).toBe(false)
    expect(confirm.message).toContain('检查单号空缺')
  })

  it('一个检查单号只能对应一条在执行勤务，开工撞号被挡回并写明撞了哪条', () => {
    saveRows('line', [lineRow(1, '执行中', 'CHK-9'), lineRow(2, '待执行', 'CHK-9')])
    const result = runLineAction(2, '开始勤务')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('CHK-9')
    expect(result.message).toContain('LINE-0001')
    expect(result.message).toContain('一个检查单号只能对应一条在执行勤务')
    expect(lineStatus(2)).toBe('待执行')
  })

  it('提交放行时再撞号同样被挡回', () => {
    saveRows('line', [lineRow(1, '待放行', 'CHK-9'), lineRow(2, '执行中', 'CHK-9')])
    const result = runLineAction(2, '提交放行')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('LINE-0001')
  })

  it('已放行任务的检查单号随单归档，不再占用，新任务可以复用', () => {
    saveRows('line', [lineRow(1, '已放行', 'CHK-9'), lineRow(2, '待执行', 'CHK-9')])
    expect(runLineAction(2, '开始勤务').ok).toBe(true)
  })

  it('待执行不算占用：先开工的拿到号码，后开工的被挡', () => {
    saveRows('line', [lineRow(1, '待执行', 'CHK-9'), lineRow(2, '待执行', 'CHK-9')])
    expect(runLineAction(1, '开始勤务').ok).toBe(true)
    const late = runLineAction(2, '开始勤务')
    expect(late.ok).toBe(false)
    expect(late.message).toContain('LINE-0001')
  })
})

describe('放行状态与检查单号对不上的判定', () => {
  it('已放行但检查单号空缺：按未放行计，并标异常', () => {
    const broken = lineRow(1, '已放行', '')
    expect(isEffectiveRelease(broken)).toBe(false)
    saveRows('line', [broken])
    reconcileLineRelease()
    expect(listRows('line')[0].abnormal).toBe(true)
  })

  it('已放行且凭证齐全才算生效，核验通过后异常标记被摘掉', () => {
    const good = lineRow(1, '已放行', 'CHK-1')
    good.abnormal = true
    expect(isEffectiveRelease(good)).toBe(true)
    saveRows('line', [good])
    reconcileLineRelease()
    expect(listRows('line')[0].abnormal).toBe(false)
  })

  it('不同在执行任务撞同一个检查单号，两条都标异常', () => {
    saveRows('line', [lineRow(1, '执行中', 'CHK-9'), lineRow(2, '待放行', 'CHK-9')])
    reconcileLineRelease()
    expect(listRows('line').map((row) => row.abnormal)).toEqual([true, true])
  })

  it('listEntries 读取前自动核验，对不上的任务当场带异常标记', () => {
    saveRows('line', [lineRow(1, '已放行', '')])
    const page = listEntries('line')
    expect(page.items[0].abnormal).toBe(true)
  })
})

describe('航班保障台账的放行待办', () => {
  it('按航班号关联勤务任务，未放行的航班挂待办', () => {
    saveRows('line', [lineRow(1, '执行中', 'CHK-1', 'CA1502')])
    saveRows('flight', [flightRow(1, 'CA1502'), flightRow(2, 'CA1599')])
    const ledger = flightReleaseLedger()
    const ca1502 = ledger.find((item) => item.航班号 === 'CA1502')
    expect(ca1502).toMatchObject({ linked: 1, released: 0, state: '待放行', todo: true })
    const ca1599 = ledger.find((item) => item.航班号 === 'CA1599')
    expect(ca1599).toMatchObject({ linked: 0, state: '未关联勤务', todo: false })
  })

  it('勤务确认放行后台账待办跟着销掉：两边读的是同一份状态', () => {
    saveRows('line', [lineRow(1, '待放行', 'CHK-1', 'CA1502')])
    saveRows('flight', [flightRow(1, 'CA1502')])
    expect(flightReleaseLedger()[0].todo).toBe(true)
    expect(runLineAction(1, '确认放行').ok).toBe(true)
    const after = flightReleaseLedger()[0]
    expect(after).toMatchObject({ released: 1, state: '已放行', todo: false })
  })

  it('状态已放行但检查单号空缺时，台账仍挂待办（就低处理）', () => {
    saveRows('line', [lineRow(1, '已放行', '', 'CA1502')])
    saveRows('flight', [flightRow(1, 'CA1502')])
    const item = flightReleaseLedger()[0]
    expect(item.todo).toBe(true)
    expect(item.released).toBe(0)
  })

  it('同一航班多条勤务全放行才算已放行，部分放行仍是待办', () => {
    saveRows('line', [
      lineRow(1, '已放行', 'CHK-1', 'CA1502'),
      lineRow(2, '待放行', 'CHK-2', 'CA1502'),
    ])
    saveRows('flight', [flightRow(1, 'CA1502')])
    const item = flightReleaseLedger()[0]
    expect(item).toMatchObject({ linked: 2, released: 1, state: '部分放行', todo: true })
  })
})

describe('页面动作可用性', () => {
  it('勤务任务每个状态只放行链上的下一个动作，已放行后无动作可点', () => {
    expect(nextLineAction('待执行')).toBe('开始勤务')
    expect(nextLineAction('执行中')).toBe('提交放行')
    expect(nextLineAction('待放行')).toBe('确认放行')
    expect(nextLineAction('已放行')).toBeNull()
    expect(allowedActions('line', lineRow(1, '已放行', 'CHK-1'))).toEqual([])
    expect(allowedActions('line', lineRow(1, '待执行', 'CHK-1'))).toEqual(['开始勤务'])
  })

  it('local-service 的 runAction 命中 line 时走链式校验', () => {
    saveRows('line', [lineRow(1, '待执行', 'CHK-1')])
    const result = runAction('line', 1, '确认放行')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('逐级推进')
  })

  it('其它模块的动作流转不受放行链影响', () => {
    saveRows('flight', [flightRow(1, 'CA1501')])
    const result = runAction('flight', 1, '确认完成')
    expect(result.ok).toBe(true)
  })
})
