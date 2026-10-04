<template>
  <section class="page" data-module="line">
    <header class="page-head">
      <div>
        <h2>机务勤务管理</h2>
        <p class="page-desc">放行按「待执行 → 执行中 → 待放行 → 已放行」串成一条链，检查单号对一条在执行勤务，单号空缺或步骤没签完不许放行。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记勤务任务</button>
        <button class="btn" type="button" @click="exportRows">导出机务勤务清单</button>
      </div>
    </header>

    <div class="rule-banner">
      <strong>放行链规则：</strong>
      <span>① {{ ruleText.chain }}，只许前进不许回退；</span>
      <span>② 检查单号在「执行中 / 待放行」勤务间唯一，撞号挡回并点名冲突任务；</span>
      <span>③ 检查单号空缺、开始或完工未签字，提交/确认放行一律挡回；</span>
      <span>④ 已放行不能回到执行中，重复放行只生效一次；</span>
      <span>⑤ 放行结论以本任务链为唯一事实源，航班保障台账的放行待办按此对账。</span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>放行链操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '检查单号' && row.status === '执行中'">
              <div class="inline-edit">
                <input
                  class="sheet-input"
                  v-model="sheetDrafts[sheetKey(row)]"
                  placeholder="登记检查单号"
                  @keyup.enter="saveSheet(row)"
                />
                <button class="link" type="button" @click="saveSheet(row)">保存单号</button>
              </div>
            </template>
            <template v-else-if="column === '步骤签字'">
              <span v-if="row[column]">{{ row[column] }}</span>
              <span v-else class="text-muted">未签字</span>
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>
            <span class="status-tag" :data-status="row.status">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <template v-for="action in actionsFor(row)" :key="action.key">
              <button
                v-if="!action.disabled"
                class="link"
                :class="{ 'link-muted': action.muted }"
                type="button"
                @click="invoke(action.key, row)"
              >
                {{ action.label }}
              </button>
              <span v-else class="text-muted">{{ action.label }}</span>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机务勤务数据，可先登记勤务任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条机务勤务记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  bindCheckSheet,
  confirmRelease,
  LINE_RELEASE_RULES,
  signFinish,
  startDuty,
  submitForRelease,
} from '@/api/line-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import type { LineActionResult } from '@/api/line-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('line')
const columns = [
  '任务编号', '航班号', '勤务项目', '放行人员', '开始时间', '结束时间',
  '检查单号', '步骤签字', '开始签字', '完工签字', '提交放行时间', '放行时间',
]
const statuses = ['待执行', '执行中', '待放行', '已放行']
const ruleText = LINE_RELEASE_RULES

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['任务编号', '航班号', '勤务项目', '检查单号']
const sheetDrafts = reactive<Record<string, string>>({})

const stats = computed(() => [
  { label: '待执行勤务', value: countByStatus('待执行') },
  { label: '执行中勤务', value: countByStatus('执行中') },
  { label: '待放行任务', value: countByStatus('待放行') },
  { label: '已放行任务', value: countByStatus('已放行') },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function sheetKey(row: EntryRow): string {
  return String(row.id)
}

// 放行链上每一步只给当前能做的动作，已放行只留一个灰色「重复放行」演示幂等拦截。
function actionsFor(row: EntryRow): { key: string; label: string; disabled: boolean; muted?: boolean }[] {
  const steps = String(row['步骤签字'] ?? '').split('、').filter(Boolean)
  switch (String(row.status)) {
    case '待执行':
      return [{ key: '开始勤务', label: '开始勤务', disabled: false }]
    case '执行中':
      return [
        { key: '完工签字', label: steps.includes('完工确认') ? '完工已签' : '完工签字', disabled: steps.includes('完工确认'), muted: steps.includes('完工确认') },
        { key: '提交放行', label: '提交放行', disabled: false },
      ]
    case '待放行':
      return [{ key: '确认放行', label: '确认放行', disabled: false }]
    case '已放行':
      return [{ key: '重复放行', label: '已放行（再点只生效一次）', disabled: false, muted: true }]
    default:
      return []
  }
}

function invoke(key: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  let result: LineActionResult
  switch (key) {
    case '开始勤务':
      result = startDuty(Number(row.id))
      break
    case '完工签字':
      result = signFinish(Number(row.id))
      break
    case '提交放行':
      result = submitForRelease(Number(row.id))
      break
    case '确认放行':
    case '重复放行':
      result = confirmRelease(Number(row.id))
      break
    default:
      result = { ok: false, message: `未登记的放行链动作：${key}` }
  }
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function saveSheet(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = bindCheckSheet(Number(row.id), sheetDrafts[sheetKey(row)] ?? '')
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '勤务任务登记入口尚未接入审批流'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    for (const row of rows.value) {
      const key = sheetKey(row)
      if (sheetDrafts[key] === undefined) {
        sheetDrafts[key] = String(row['检查单号'] ?? '')
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '机务勤务列表读取失败'
  }
}

onMounted(reload)
</script>
