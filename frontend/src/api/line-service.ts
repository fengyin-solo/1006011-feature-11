import {
  RELEASE_DONE,
  RELEASE_PENDING,
  upsertLedgerEntry,
} from '@/data/release-ledger'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 机务勤务放行链：待执行 → 执行中 → 待放行 → 已放行。
// 检查单号在「在执行勤务」（执行中、待放行）上唯一；放行前必须单号在册、步骤签字齐全。

const STATUSES = ['待执行', '执行中', '待放行', '已放行'] as const
const ACTIVE_STATUSES = ['执行中', '待放行']

const FIELD_TASK_NO = '任务编号'
const FIELD_FLIGHT_NO = '航班号'
const FIELD_CHECK_SHEET = '检查单号'
const FIELD_RELEASER = '放行人员'
const FIELD_START_TIME = '开始时间'
const FIELD_END_TIME = '结束时间'
const FIELD_START_SIGN = '开始签字'
const FIELD_FINISH_SIGN = '完工签字'
const FIELD_SUBMITTED_AT = '提交放行时间'
const FIELD_RELEASED_AT = '放行时间'
const FIELD_STEP_SIGNS = '步骤签字'

export type LineActionResult = ActionResult & { duplicated?: boolean }

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`
}

function currentOperator(): string {
  // 与 stores/session 的默认值班人保持一致；数据层不依赖 pinia 生命周期。
  return '值班管理员'
}

function lineRows(): EntryRow[] {
  return listRows('line')
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === Number(id))
}

function describe(row: EntryRow): string {
  return `${text(row[FIELD_TASK_NO]) || `编号${row.id}`}（${text(row[FIELD_FLIGHT_NO]) || '无航班号'}）`
}

function requireStatus(row: EntryRow, expected: string): string | null {
  const current = text(row.status)
  if (current === expected) {
    return null
  }
  const expectedIndex = STATUSES.indexOf(expected as (typeof STATUSES)[number])
  const currentIndex = STATUSES.indexOf(current as (typeof STATUSES)[number])
  if (currentIndex > expectedIndex) {
    return `任务 ${describe(row)} 当前已是「${current}」，不允许回到「${expected}」`
  }
  if (currentIndex < expectedIndex) {
    const missing = STATUSES.slice(currentIndex, expectedIndex).join('、')
    return `任务 ${describe(row)} 当前为「${current}」，必须先走完「${missing}」，不能跳到「${expected}」`
  }
  return null
}

function signedSteps(row: EntryRow): string[] {
  return text(row[FIELD_STEP_SIGNS])
    .split('、')
    .map((item) => item.trim())
    .filter(Boolean)
}

function withSteps(row: EntryRow, steps: string[]): EntryRow {
  return { ...row, [FIELD_STEP_SIGNS]: Array.from(new Set(steps)).join('、') }
}

function persist(rows: EntryRow[], updated: EntryRow): void {
  const next = rows.map((row) => (Number(row.id) === Number(updated.id) ? updated : row))
  saveRows('line', next)
}

// 检查单号唯一性：只在「在执行勤务」（执行中、待放行）之间判重；待执行还没占用、已放行已释放。
function findSheetConflict(
  rows: EntryRow[],
  checkSheetNo: string,
  selfId: number,
): EntryRow | undefined {
  if (!checkSheetNo) {
    return undefined
  }
  return rows.find(
    (row) =>
      Number(row.id) !== Number(selfId) &&
      ACTIVE_STATUSES.includes(text(row.status) as (typeof ACTIVE_STATUSES)[number]) &&
      text(row[FIELD_CHECK_SHEET]) === checkSheetNo,
  )
}

function fail(message: string): LineActionResult {
  return { ok: false, message }
}

// 开始勤务：待执行 → 执行中。
export function startDuty(id: number): LineActionResult {
  const rows = lineRows()
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的勤务任务`)
  }
  const error = requireStatus(row, '待执行')
  if (error) {
    return fail(error)
  }
  const updated = withSteps(
    {
      ...row,
      status: '执行中',
      pending: true,
      [FIELD_START_TIME]: text(row[FIELD_START_TIME]) || nowText(),
      [FIELD_START_SIGN]: currentOperator(),
    },
    [...signedSteps(row), '开始勤务'],
  )
  persist(rows, updated)
  return { ok: true, message: `任务 ${describe(updated)} 已开始勤务，进入「执行中」` }
}

// 完工签字：执行中任务补上上一步（现场作业）签字，提交放行前必须完成。
export function signFinish(id: number): LineActionResult {
  const rows = lineRows()
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的勤务任务`)
  }
  if (text(row.status) === '待执行') {
    return fail(`任务 ${describe(row)} 还没开始勤务，不能先签完工`)
  }
  if (text(row.status) === '已放行') {
    return fail(`任务 ${describe(row)} 已放行，放行链已终结，不能补签`)
  }
  const steps = signedSteps(row)
  if (steps.includes('完工确认')) {
    return { ok: true, message: `任务 ${describe(row)} 完工签字已存在，不用重复签` }
  }
  const updated = withSteps(
    {
      ...row,
      [FIELD_END_TIME]: text(row[FIELD_END_TIME]) || nowText(),
      [FIELD_FINISH_SIGN]: currentOperator(),
    },
    [...steps, '完工确认'],
  )
  persist(rows, updated)
  return { ok: true, message: `任务 ${describe(row)} 完工已由 ${currentOperator()} 签字` }
}

// 执行环节登记/更正检查单号：在执行勤务之间判重，撞号挡回并写明和哪条撞了。
export function bindCheckSheet(id: number, checkSheetNo: string): LineActionResult {
  const sheet = checkSheetNo.trim()
  const rows = lineRows()
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的勤务任务`)
  }
  const status = text(row.status)
  if (status === '已放行') {
    return fail(`任务 ${describe(row)} 已放行，检查单号已随放行锁定，不能更改`)
  }
  if (status === '待放行') {
    return fail(
      `任务 ${describe(row)} 已提交放行，检查单号锁定；如需更正请先由放行环节打回执行中`,
    )
  }
  if (status !== '执行中') {
    return fail(`任务 ${describe(row)} 当前为「${status}」，检查单号在开始勤务后登记`)
  }
  const conflict = findSheetConflict(rows, sheet, id)
  if (conflict) {
    return fail(
      `检查单号「${sheet}」已被在执行勤务 ${describe(conflict)} 占用，` +
        `一个检查单号只能对应一条在执行勤务，本次登记挡回`,
    )
  }
  const updated: EntryRow = { ...row, [FIELD_CHECK_SHEET]: sheet }
  persist(rows, updated)
  return {
    ok: true,
    message: sheet
      ? `任务 ${describe(row)} 检查单号已登记为「${sheet}」`
      : `任务 ${describe(row)} 检查单号已清空`,
  }
}

function releaseReady(row: EntryRow): string | null {
  const sheet = text(row[FIELD_CHECK_SHEET])
  if (!sheet) {
    return `任务 ${describe(row)} 检查单号空缺，补齐检查单号后才能提交放行`
  }
  const steps = signedSteps(row)
  if (!steps.includes('开始勤务')) {
    return `任务 ${describe(row)} 缺少「开始勤务」签字，步骤没走完不许放行`
  }
  if (!steps.includes('完工确认')) {
    return `任务 ${describe(row)} 缺少「完工确认」签字，上一步没签字不许放行`
  }
  return null
}

function syncLedger(row: EntryRow, releaseStatus: typeof RELEASE_PENDING | typeof RELEASE_DONE): void {
  upsertLedgerEntry({
    taskId: Number(row.id),
    taskNo: text(row[FIELD_TASK_NO]),
    flightNo: text(row[FIELD_FLIGHT_NO]),
    checkSheetNo: text(row[FIELD_CHECK_SHEET]),
    releaseStatus,
    releaser: text(row[FIELD_RELEASER]),
    submittedAt: text(row[FIELD_SUBMITTED_AT]),
    releasedAt: text(row[FIELD_RELEASED_AT]),
  })
}

// 提交放行：执行中 → 待放行。单号、签字两道闸口 + 撞号复核。
export function submitForRelease(id: number): LineActionResult {
  const rows = lineRows()
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的勤务任务`)
  }
  const statusError = requireStatus(row, '执行中')
  if (statusError) {
    return fail(statusError)
  }
  const readyError = releaseReady(row)
  if (readyError) {
    return fail(readyError)
  }
  const sheet = text(row[FIELD_CHECK_SHEET])
  const conflict = findSheetConflict(rows, sheet, id)
  if (conflict) {
    return fail(
      `检查单号「${sheet}」与在执行勤务 ${describe(conflict)} 撞号，` +
        '一个检查单号只能对应一条在执行勤务，提交放行挡回',
    )
  }
  const updated: EntryRow = {
    ...row,
    status: RELEASE_PENDING,
    pending: true,
    [FIELD_SUBMITTED_AT]: nowText(),
  }
  persist(rows, updated)
  syncLedger(updated, RELEASE_PENDING)
  return { ok: true, message: `任务 ${describe(updated)} 已提交放行，进入「待放行」并挂到航班保障放行待办` }
}

// 确认放行：待放行 → 已放行。重复放行幂等：只生效一次，不重复挂账。
export function confirmRelease(id: number): LineActionResult {
  const rows = lineRows()
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的勤务任务`)
  }
  if (text(row.status) === RELEASE_DONE) {
    return {
      ok: true,
      duplicated: true,
      message: `任务 ${describe(row)} 已放行，重复放行只生效一次：首次放行结论为准，本次不重复挂账`,
    }
  }
  const statusError = requireStatus(row, RELEASE_PENDING)
  if (statusError) {
    return fail(statusError)
  }
  // 放行是最终闸口，再核一遍单号与签字，防止数据被绕过页面改脏。
  const readyError = releaseReady(row)
  if (readyError) {
    return fail(readyError)
  }
  const sheet = text(row[FIELD_CHECK_SHEET])
  const conflict = findSheetConflict(rows, sheet, id)
  if (conflict) {
    return fail(
      `检查单号「${sheet}」与在执行勤务 ${describe(conflict)} 撞号，确认放行挡回`,
    )
  }
  const updated: EntryRow = {
    ...row,
    status: RELEASE_DONE,
    pending: false,
    abnormal: false,
    [FIELD_RELEASER]: text(row[FIELD_RELEASER]) || currentOperator(),
    [FIELD_RELEASED_AT]: nowText(),
  }
  persist(rows, updated)
  syncLedger(updated, RELEASE_DONE)
  return { ok: true, message: `任务 ${describe(updated)} 已确认放行，放行结论已同步到航班保障台账` }
}

export const LINE_RELEASE_RULES = {
  chain: STATUSES.join(' → '),
  activeStatuses: ACTIVE_STATUSES,
}
