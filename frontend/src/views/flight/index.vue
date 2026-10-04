<template>
  <section class="page" data-module="flight">
    <header class="page-head">
      <div>
        <h2>航班保障管理</h2>
        <p class="page-desc">维护航班保障任务，围绕保障编号、航班号、机型、计划到达做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记航班保障任务</button>
        <button class="btn" type="button" @click="exportRows">导出航班保障清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="release-panel">
      <header class="release-panel-head">
        <div>
          <h3>航班保障台账 · 放行待办</h3>
          <p class="page-desc">放行结论直接取自机务勤务任务链，台账只做存根；每次读取自动对账，状态不一致时当场纠正。</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" @click="loadReleaseBoard">重新对账</button>
        </div>
      </header>

      <p class="basis-text">判定依据：{{ releaseBoard.basis }}</p>

      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">待放行（机务已提交待确认）</span>
          <strong class="stat-value">{{ releaseBoard.todos.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">已放行（结论已生效）</span>
          <strong class="stat-value">{{ releaseBoard.released.length }}</strong>
        </article>
      </div>

      <p v-if="releaseBoard.corrections.length" class="error-text">
        本次对账发现并纠正 {{ releaseBoard.corrections.length }} 处台账与任务链不一致：
      </p>
      <ul v-if="releaseBoard.corrections.length" class="correction-list">
        <li v-for="(item, index) in releaseBoard.corrections" :key="index">{{ item }}</li>
      </ul>

      <table class="data-table">
        <thead>
          <tr>
            <th>勤务任务编号</th>
            <th>航班号</th>
            <th>检查单号</th>
            <th>放行状态</th>
            <th>放行人员</th>
            <th>提交放行时间</th>
            <th>放行时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in releaseBoard.todos" :key="`todo-${item.taskId}`">
            <td>{{ item.taskNo }}</td>
            <td>{{ item.flightNo }}</td>
            <td>{{ item.checkSheetNo || '—' }}</td>
            <td><span class="status-tag" data-status="待放行">{{ item.releaseStatus }}</span></td>
            <td>{{ item.releaser || '待放行人员确认' }}</td>
            <td>{{ item.submittedAt || '—' }}</td>
            <td>—</td>
          </tr>
          <tr v-if="!releaseBoard.todos.length">
            <td colspan="7" class="empty-state">当前没有待放行任务</td>
          </tr>
        </tbody>
      </table>

      <h4 class="release-subtitle">已放行记录（只读，以任务链为准）</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>勤务任务编号</th>
            <th>航班号</th>
            <th>检查单号</th>
            <th>放行状态</th>
            <th>放行人员</th>
            <th>提交放行时间</th>
            <th>放行时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in releaseBoard.released" :key="`done-${item.taskId}`">
            <td>{{ item.taskNo }}</td>
            <td>{{ item.flightNo }}</td>
            <td>{{ item.checkSheetNo || '—' }}</td>
            <td><span class="status-tag" data-status="已放行">{{ item.releaseStatus }}</span></td>
            <td>{{ item.releaser || '—' }}</td>
            <td>{{ item.submittedAt || '—' }}</td>
            <td>{{ item.releasedAt || '—' }}</td>
          </tr>
          <tr v-if="!releaseBoard.released.length">
            <td colspan="7" class="empty-state">暂无已放行记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <h4 class="release-subtitle">航班保障任务清单</h4>

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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无航班保障数据，可先登记航班保障任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { reconcileReleaseLedger } from '@/data/release-ledger'
import type { ReleaseLedgerView } from '@/data/release-ledger'
import type { EntryRow } from '@/data/types'

const emptyReleaseBoard = (): ReleaseLedgerView => ({ todos: [], released: [], corrections: [], basis: '' })

const meta = moduleMeta('flight')
const columns = ["保障编号", "航班号", "机型", "计划到达", "机位号", "保障等级", "保障班组", "保障状态"]
const actions = ["接收任务", "开始保障", "确认完成"]
const statuses = ["待接收", "保障中", "保障完成", "已终止"]
const stats = [{"label": "今日保障任务", "value": 0}, {"label": "保障中任务", "value": 0}, {"label": "保障完成率", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const releaseBoard = ref<ReleaseLedgerView>(emptyReleaseBoard())
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '航班保障任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function loadReleaseBoard() {
  errorMessage.value = ''
  try {
    releaseBoard.value = reconcileReleaseLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '放行待办读取失败'
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadReleaseBoard()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航班保障列表读取失败'
  }
}

onMounted(reload)
</script>
