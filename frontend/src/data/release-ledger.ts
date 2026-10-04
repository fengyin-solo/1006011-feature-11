import { listRows } from './local-store'

// 航班保障台账里的放行存根：它是机务勤务任务链的派生投影，自己不产生放行结论。
// 单独存一份，是为了在台账滞后/串号时能按任务链对账纠偏，而不是让页面各读各的。

const LEDGER_STORAGE_KEY = 'airport-ground-ops:release-ledger'

export const RELEASE_PENDING = '待放行'
export const RELEASE_DONE = '已放行'

// 判定依据：放行状态、检查单号、签字都在机务勤务任务链上产生，台账只存根、不判定。
export const RELEASE_SOURCE_BASIS =
  '放行结论以机务勤务任务链为唯一事实源：放行状态由任务链的放行动作产生，检查单号在任务执行环节登记并做唯一性校验；' +
  '航班保障台账的放行待办仅为派生存根，读取时按任务链对账纠正，台账不得反向回写任务链。'

export type ReleaseLedgerEntry = {
  taskId: number
  taskNo: string
  flightNo: string
  checkSheetNo: string
  releaseStatus: typeof RELEASE_PENDING | typeof RELEASE_DONE
  releaser: string
  submittedAt: string
  releasedAt: string
}

export type ReleaseTodo = ReleaseLedgerEntry

export type ReleaseLedgerView = {
  todos: ReleaseTodo[]
  released: ReleaseTodo[]
  corrections: string[]
  basis: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 刻意留一份与任务链对不上的台账存根：首次打航班保障页就能看到对账是怎么纠偏的。
function seedLedger(): ReleaseLedgerEntry[] {
  return [
    {
      taskId: 3,
      taskNo: 'LINE-2026-1003',
      flightNo: 'CZ3107',
      checkSheetNo: 'CHK-WRONG-0009',
      releaseStatus: RELEASE_DONE,
      releaser: '王建国',
      submittedAt: '2026-10-03 09:05',
      releasedAt: '2026-10-03 09:10',
    },
    {
      taskId: 4,
      taskNo: 'LINE-2026-1004',
      flightNo: 'CA1503',
      checkSheetNo: 'CHK-2026-0930',
      releaseStatus: RELEASE_PENDING,
      releaser: '',
      submittedAt: '2026-10-03 07:40',
      releasedAt: '',
    },
  ]
}

function readStorage(): ReleaseLedgerEntry[] {
  const fallback = seedLedger()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(LEDGER_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as ReleaseLedgerEntry[]
    return Array.isArray(parsed) ? parsed : clone(fallback)
  } catch {
    window.localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: ReleaseLedgerEntry[] | null = null

export function listLedger(): ReleaseLedgerEntry[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveLedger(entries: ReleaseLedgerEntry[]): void {
  cache = entries
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(entries))
  }
}

// 台账写入只由任务链动作驱动：同任务按 taskId 覆盖，天然不会重复挂账。
export function upsertLedgerEntry(entry: ReleaseLedgerEntry): void {
  const entries = listLedger()
  const index = entries.findIndex((item) => item.taskId === entry.taskId)
  if (index >= 0) {
    entries[index] = { ...entries[index], ...entry }
  } else {
    entries.push(entry)
  }
  saveLedger(entries)
}

function fieldText(value: unknown): string {
  return String(value ?? '').trim()
}

// 读取放行待办：待办/已放行直接按机务勤务任务链构建，台账存根只用来对账，
// 所以台账哪怕滞后或串号，航班保障页读到的状态也不会是"另一份"。
export function reconcileReleaseLedger(): ReleaseLedgerView {
  const ledger = listLedger()
  const ledgerById = new Map(ledger.map((entry) => [entry.taskId, entry]))

  const todos: ReleaseTodo[] = []
  const released: ReleaseTodo[] = []
  const corrections: string[] = []

  for (const row of listRows('line')) {
    const status = String(row.status)
    if (status !== RELEASE_PENDING && status !== RELEASE_DONE) {
      continue
    }
    const taskId = Number(row.id)
    const taskNo = fieldText(row['任务编号'])
    const flightNo = fieldText(row['航班号'])
    const checkSheetNo = fieldText(row['检查单号'])
    const releaser = fieldText(row['放行人员'])
    const submittedAt = fieldText(row['提交放行时间'])
    const releasedAt = fieldText(row['放行时间'])

    const entry: ReleaseTodo = {
      taskId,
      taskNo,
      flightNo,
      checkSheetNo,
      releaseStatus: status as typeof RELEASE_PENDING | typeof RELEASE_DONE,
      releaser,
      submittedAt,
      releasedAt,
    }
    ;(status === RELEASE_PENDING ? todos : released).push(entry)

    const snap = ledgerById.get(taskId)
    if (!snap) {
      corrections.push(
        `任务 ${taskNo}：台账缺少${status === RELEASE_DONE ? '放行存根' : '待放行待办'}，` +
          `已按机务勤务任务链补记为「${status}」。判定依据：${RELEASE_SOURCE_BASIS}`,
      )
    } else {
      if (snap.releaseStatus !== status) {
        corrections.push(
          `任务 ${taskNo}：台账记录为「${snap.releaseStatus}」，任务链实际为「${status}」，` +
            `以机务勤务任务链为准纠正。判定依据：${RELEASE_SOURCE_BASIS}`,
        )
      }
      if (fieldText(snap.checkSheetNo) !== checkSheetNo) {
        corrections.push(
          `任务 ${taskNo}：台账检查单号为「${fieldText(snap.checkSheetNo) || '空缺'}」，` +
            `任务链登记为「${checkSheetNo || '空缺'}」，以任务链登记为准纠正。` +
            `判定依据：检查单号在任务执行环节登记并做唯一性校验，台账不掌握原始登记。`,
        )
      }
    }
  }

  if (corrections.length > 0) {
    // 对账后把台账修到与任务链一致；任务链本身一行都不改。
    saveLedger([...todos, ...released].map((entry) => clone(entry)))
  }

  return { todos, released, corrections, basis: RELEASE_SOURCE_BASIS }
}
