import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 机务勤务放行链：状态只能按 待执行 → 执行中 → 待放行 → 已放行 逐级推进，
// 不许跳步、不许回退。这条链是放行事实的唯一来源，航班保障台账直接读它，不另存一份。
const LINE_KEY = 'line'
const CHAIN = ['待执行', '执行中', '待放行', '已放行'] as const
const RELEASED = '已放行'

// 动作 → 目标状态；动作的合法起点就是目标状态在链上的前一级。
const ACTION_TARGETS: Record<string, (typeof CHAIN)[number]> = {
  开始勤务: '执行中',
  提交放行: '待放行',
  确认放行: '已放行',
}

// 「在执行」= 已经开工但还没放行的任务。检查单号的唯一性只约束这个区间：
// 待执行的任务还没开工不算占用，已放行的任务随单归档、号码不再占用。
const ACTIVE_STATUSES = new Set<string>(['执行中', '待放行'])

function checkNoOf(row: EntryRow): string {
  return String(row['检查单号'] ?? '').trim()
}

function taskNoOf(row: EntryRow): string {
  return String(row['任务编号'] ?? row.id)
}

/**
 * 放行是否生效的判定依据：
 * 1. 状态链是系统按顺序写入的流转记录，每推进一步都校验过上一步和检查单号，
 *    不可跳步、不可回退，所以「放行了没有」以状态链为准，不以人工填写的字段为准。
 * 2. 检查单号是放行的必备凭证，不是放行事实本身。状态到达已放行、但检查单号空缺，
 *    属于两边对不上：放行是安全关键结论，缺凭证一律就低处理——按未放行计，
 *    航班保障台账继续挂放行待办，任务本身由 reconcileLineRelease 标异常待人工核查。
 */
export function isEffectiveRelease(row: EntryRow): boolean {
  return String(row.status) === RELEASED && checkNoOf(row) !== ''
}

/** 同一条任务当前还允许执行哪个动作；已放行之后什么都不允许，尤其不允许回到执行中。 */
export function nextLineAction(status: string): string | null {
  const index = CHAIN.indexOf(status as (typeof CHAIN)[number])
  if (index < 0 || index >= CHAIN.length - 1) {
    return null
  }
  const target = CHAIN[index + 1]
  const action = Object.keys(ACTION_TARGETS).find((name) => ACTION_TARGETS[name] === target)
  return action ?? null
}

/** 检查单号是否被另一条在执行勤务占用；撞上了就把那条任务带回来，好写进挡回原因。 */
function findActiveConflict(rows: EntryRow[], selfId: number, checkNo: string): EntryRow | null {
  if (checkNo === '') {
    return null
  }
  for (const row of rows) {
    if (Number(row.id) === selfId) {
      continue
    }
    if (ACTIVE_STATUSES.has(String(row.status)) && checkNoOf(row) === checkNo) {
      return row
    }
  }
  return null
}

function conflictMessage(checkNo: string, other: EntryRow): string {
  return `检查单号 ${checkNo} 已挂在勤务任务 ${taskNoOf(other)}（${String(other.status)}）上，` +
    `一个检查单号只能对应一条在执行勤务，本次操作被挡回`
}

/**
 * 勤务任务的链式动作入口。local-service 的 runAction 命中 line 模块时整段委托到这里，
 * 通用流转不再适用——放行链的每一步都要先过状态顺序、检查单号空缺、撞号这三道闸。
 */
export function runLineAction(id: number, action: string): ActionResult {
  const target = ACTION_TARGETS[action]
  if (!target) {
    return { ok: false, message: `勤务任务没有登记「${action}」这个动作` }
  }
  const rows = listRows(LINE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的勤务任务` }
  }
  const row = rows[index]
  const current = String(row.status)
  const currentIndex = CHAIN.indexOf(current as (typeof CHAIN)[number])
  const expected = CHAIN[CHAIN.indexOf(target) - 1]

  // 重复放行只生效一次：状态不动、台账不动，只回一句已经生效过。
  if (action === '确认放行' && current === RELEASED) {
    return { ok: true, message: `勤务任务 ${taskNoOf(row)} 已放行过，重复放行不重复生效` }
  }
  if (current === RELEASED) {
    return { ok: false, message: `勤务任务 ${taskNoOf(row)} 已放行，不允许回到执行中或其它状态` }
  }
  if (currentIndex < 0 || current !== expected) {
    return {
      ok: false,
      message: `「${action}」要求任务处于「${expected}」，当前是「${current}」，` +
        `勤务状态只能按 ${CHAIN.join('→')} 逐级推进`,
    }
  }

  const checkNo = checkNoOf(row)
  if ((action === '提交放行' || action === '确认放行') && checkNo === '') {
    return { ok: false, message: `勤务任务 ${taskNoOf(row)} 的检查单号空缺，不许放行，请先补录检查单号` }
  }
  if (action === '开始勤务' || action === '提交放行') {
    const conflict = findActiveConflict(rows, id, checkNo)
    if (conflict) {
      return { ok: false, message: conflictMessage(checkNo, conflict) }
    }
  }

  const next = [...rows]
  next[index] = { ...row, status: target, pending: target !== RELEASED }
  saveRows(LINE_KEY, next)
  return { ok: true, message: `勤务任务已${action}，当前状态「${target}」` }
}

/**
 * 完整性核验：把「状态」和「检查单号」两边对不上的任务标成异常（或恢复）。
 * 两类对不上：已放行但检查单号空缺；不同在执行任务撞同一个检查单号。
 * line 模块的 abnormal 标记由这道核验全权维护，动作流转里不再另写。
 */
export function reconcileLineRelease(): void {
  const rows = listRows(LINE_KEY)
  const activeByCheckNo = new Map<string, number>()
  const duplicated = new Set<number>()
  for (const row of rows) {
    if (!ACTIVE_STATUSES.has(String(row.status))) {
      continue
    }
    const checkNo = checkNoOf(row)
    if (checkNo === '') {
      continue
    }
    const holder = activeByCheckNo.get(checkNo)
    if (holder === undefined) {
      activeByCheckNo.set(checkNo, Number(row.id))
    } else {
      duplicated.add(holder)
      duplicated.add(Number(row.id))
    }
  }
  let changed = false
  const next = rows.map((row) => {
    const conflict =
      (String(row.status) === RELEASED && checkNoOf(row) === '') || duplicated.has(Number(row.id))
    if (Boolean(row.abnormal) === conflict) {
      return row
    }
    changed = true
    return { ...row, abnormal: conflict }
  })
  if (changed) {
    saveRows(LINE_KEY, next)
  }
}

export type FlightRelease = {
  flightId: number
  航班号: string
  linked: number
  released: number
  state: '未关联勤务' | '待放行' | '部分放行' | '已放行'
  todo: boolean
}

/**
 * 航班保障台账的放行待办：按航班号把勤务任务挂到航班保障任务上，
 * 放行状态现场从勤务任务算出来（同一份数据、同一条 isEffectiveRelease 判定），
 * 台账自己不存放行状态，所以两边永远读的是一份。
 */
export function flightReleaseLedger(): FlightRelease[] {
  reconcileLineRelease()
  const lineRows = listRows(LINE_KEY)
  return listRows('flight').map((flight) => {
    const flightNo = String(flight['航班号'] ?? '').trim()
    const linked =
      flightNo === ''
        ? []
        : lineRows.filter((row) => String(row['航班号'] ?? '').trim() === flightNo)
    const released = linked.filter(isEffectiveRelease).length
    const state =
      linked.length === 0
        ? '未关联勤务'
        : released === linked.length
          ? '已放行'
          : released > 0
            ? '部分放行'
            : '待放行'
    return {
      flightId: Number(flight.id),
      航班号: flightNo,
      linked: linked.length,
      released,
      state,
      todo: linked.length > 0 && released < linked.length,
    }
  })
}

/** 单条勤务任务的放行核验结论，给列表页的「放行核验」列用。 */
export function releaseCheckText(row: EntryRow): string {
  const status = String(row.status)
  if (status === RELEASED) {
    return checkNoOf(row) === '' ? '状态已放行但检查单号空缺，按未放行计' : '已放行，凭证齐全'
  }
  if (row.abnormal) {
    return '检查单号与其它在执行任务撞号'
  }
  if (status === '待放行') {
    return '待放行'
  }
  if (status === '执行中') {
    return checkNoOf(row) === '' ? '在执行，检查单号空缺' : '在执行'
  }
  return '未开工'
}
