<script setup lang="ts">
import { ref, computed, watch, shallowRef, markRaw } from 'vue'

/** 一条媒体记录：raw 完整保留原始 JSON 字段，其余为派生展示字段 */
interface MediaEntry {
  raw: Record<string, unknown>
  name: string
  url: string
  description: string
  image: string
  /** 时长（秒），无法解析为 null；用于展示与排序 */
  durationSec: number | null
  /** 发布时间（时间戳毫秒），无法解析为 null；用于展示与排序 */
  publishMs: number | null
}

const ACCEPT = '.json,application/json'
const PAGE_SIZE_OPTIONS = [12, 24, 36, 48, 96]

// 用 shallowRef：不对成千上万条记录及其完整 raw 做深响应式代理，避免大 JSON 在手机端触发 OOM/页面重载
const all = shallowRef<MediaEntry[]>([])
const keyword = ref('')
const pageSize = ref(24)
const page = ref(1)
/** 排序方式：default / {duration|pubdate}-{asc|desc} */
const sortKey = ref<string>('default')
const error = ref<string | null>(null)
const dragOver = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const imgError = ref<Record<string, boolean>>({})
/** 列表滚动容器，切换分页时回到顶部 */
const bodyEl = ref<HTMLElement | null>(null)

/** 兼容字段别名，提升 JSON 容错 */
function pick(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    if (typeof raw[k] === 'string') return raw[k] as string
  }
  return ''
}

/** 解析苹果 CMS 的 "高清$url#流畅$url" 多源格式，返回首个可用链接 */
function extractPlayUrl(raw: string): string {
  if (!raw) return ''
  const groups = raw.split('#')
  for (const g of groups) {
    const idx = g.indexOf('$')
    const url = idx >= 0 ? g.slice(idx + 1) : g
    if (url.trim()) return url.trim()
  }
  return ''
}

/** 解析时长：支持 "H:MM:SS"/"MM:SS"，纯数字按苹果 CMS 习惯（>1000 视为秒，否则视为分钟） */
function parseDuration(raw: Record<string, unknown>): number | null {
  const v = pick(raw, ['vod_duration', 'duration', 'vod_time', 'time', 'runtime', 'length', '时长'])
  if (!v) return null
  const s = v.trim()
  const colon = s.match(/^(?:(\d+):)?(\d+):(\d+)$/)
  if (colon) {
    const h = colon[1] ? parseInt(colon[1], 10) : 0
    return h * 3600 + parseInt(colon[2], 10) * 60 + parseInt(colon[3], 10)
  }
  const num = parseFloat(s.replace(/[^\d.]/g, ''))
  if (!isFinite(num)) return null
  return num > 1000 ? num : num * 60
}

/** 解析发布时间：日期字符串走 Date.parse；纯数字走 Unix 时间戳（秒/毫秒自适应） */
function parsePublish(raw: Record<string, unknown>): number | null {
  const v = pick(raw, [
    'vod_pubdate',
    'vod_time_add',
    'vod_add_time',
    'publish_time',
    'pubdate',
    'publishDate',
    'date',
    'created',
    'add_time',
    '发布时间',
    '发布日期'
  ])
  if (!v) return null
  const s = v.trim()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n < 1e12 ? n * 1000 : n
  }
  const t = Date.parse(s)
  return isFinite(t) ? t : null
}

/** 秒 -> "H:MM:SS" 或 "M:SS" */
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

/** 时间戳 -> 本地 "YYYY-MM-DD" */
function formatDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function buildEntry(raw: Record<string, unknown>, i: number): MediaEntry {
  const name = pick(raw, ['vod_name', 'name', 'title']) || `媒体 ${i + 1}`
  const url = extractPlayUrl(pick(raw, ['vod_play_url', 'playUrl', 'url', 'src', 'link']))
  const description = pick(raw, ['vod_blurb', 'vod_content', 'description', 'desc', 'intro', 'summary'])
  const image = pick(raw, ['vod_pic', 'image', 'poster', 'cover', 'img', 'thumbnail'])
  return {
    raw: markRaw(raw),
    name,
    url,
    description,
    image,
    durationSec: parseDuration(raw),
    publishMs: parsePublish(raw)
  }
}

/** 排序选项：字段 + 方向，保持交互一致 */
const SORT_OPTIONS = [
  { value: 'default', label: '默认顺序' },
  { value: 'duration-asc', label: '时长 ↑' },
  { value: 'duration-desc', label: '时长 ↓' },
  { value: 'pubdate-asc', label: '发布时间 ↑' },
  { value: 'pubdate-desc', label: '发布时间 ↓' }
] as const

/** 解析 JSON：兼容数组，或含 items/list/medias/data/results 的对象；保留原始结构 */
function parseJson(text: string): Record<string, unknown>[] {
  const data = JSON.parse(text)
  let arr: unknown = null
  if (Array.isArray(data)) {
    arr = data
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    arr = obj.items ?? obj.list ?? obj.medias ?? obj.media ?? obj.data ?? obj.results ?? null
  }
  if (!Array.isArray(arr)) {
    throw new Error('JSON 结构不正确：应为媒体数组，或包含 items/list/medias 等键的对象')
  }
  return arr.map((it) => (it ?? {}) as Record<string, unknown>)
}

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return all.value
  return all.value.filter(
    (e) => e.name.toLowerCase().includes(k) || e.description.toLowerCase().includes(k)
  )
})

// 排序：在过滤结果之上应用，保持原有顺序语义（default 时按文件顺序）
const sorted = computed(() => {
  const list = filtered.value
  if (sortKey.value === 'default') return list
  const [field, dir] = sortKey.value.split('-')
  const mul = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const av = field === 'duration' ? a.durationSec : a.publishMs
    const bv = field === 'duration' ? b.durationSec : b.publishMs
    // 缺失值始终排在末尾，不论升序/降序
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return (av - bv) * mul
  })
})

const totalPages = computed(() =>
  Math.max(1, Math.ceil(sorted.value.length / pageSize.value))
)

const pageItems = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return sorted.value.slice(start, start + pageSize.value)
})

// 过滤结果、每页条数或排序变化后，将当前页收敛到合法范围
watch([filtered, pageSize, sorted], () => {
  if (page.value > totalPages.value) page.value = totalPages.value
  if (page.value < 1) page.value = 1
})

// 任意分页切换（上一页/下一页/点击页码/跳页）后，列表滚动容器回到顶部，
// 确保用户从新页面的起始位置开始浏览，无需手动滚动
watch(
  page,
  () => {
    bodyEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
  },
  { flush: 'post' }
)

function openPicker() {
  inputEl.value?.click()
}

function handleFile(f: File | null | undefined) {
  error.value = null
  if (!f) return
  const isJson = /\.json$/i.test(f.name) || (f.type ? f.type.includes('json') : false)
  if (!isJson) {
    error.value = '仅支持 JSON 文件，请选择 .json 媒体列表文件。'
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const list = parseJson(String(reader.result))
      if (list.length === 0) {
        error.value = 'JSON 中未找到任何媒体项。'
        return
      }
      all.value = list.map((o, i) => buildEntry(o, i))
      keyword.value = ''
      pageSize.value = pageSize.value
      page.value = 1
      imgError.value = {}
    } catch (e) {
      error.value = 'JSON 解析失败：' + (e instanceof Error ? e.message : String(e))
    }
  }
  reader.onerror = () => {
    error.value = '文件读取失败，请重试。'
  }
  reader.readAsText(f)
}

function onChange(e: Event) {
  handleFile((e.target as HTMLInputElement).files?.[0])
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  handleFile(e.dataTransfer?.files?.[0])
}

function openItem(e: MediaEntry) {
  if (!e.url) return
  window.open(e.url, '_blank', 'noopener,noreferrer')
}

function goPrev() {
  if (page.value > 1) page.value--
}

function goNext() {
  if (page.value < totalPages.value) page.value++
}

function goPage(n: number) {
  const p = Math.min(Math.max(1, Math.floor(n || 1)), totalPages.value)
  page.value = p
}

function onJump(e: Event) {
  goPage(Number((e.target as HTMLInputElement).value))
}

function onChangeSize(e: Event) {
  pageSize.value = Number((e.target as HTMLSelectElement).value)
  page.value = 1
}

function onSortChange(e: Event) {
  sortKey.value = (e.target as HTMLSelectElement).value
  page.value = 1
}

function imgKey(e: MediaEntry): string {
  return e.url || e.name
}
</script>

<template>
  <section class="local-cinema">
    <header class="local-cinema__bar">
      <h2 class="local-cinema__title">本地影院</h2>
      <span class="local-cinema__spacer" />
      <span v-if="all.length" class="local-cinema__count">共 {{ filtered.length }} 项</span>
      <button v-if="all.length" class="local-cinema__icon-btn" type="button" :title="all.length ? '重新选择文件' : '选择本地文件'" :aria-label="all.length ? '重新选择文件' : '选择本地文件'" @click="openPicker">
        <span class="local-cinema__icon">🎬</span>
      </button>
    </header>

    <!-- 未加载：选择 JSON -->
    <div v-if="!all.length" class="local-cinema__body local-cinema__body--center">
      <div class="local-cinema__empty">
        <div
          class="local-cinema__drop"
          :class="{ 'is-over': dragOver }"
          @click="openPicker"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <div class="local-cinema__icon">🎬</div>
          <p class="local-cinema__hint">点击此处，或将本地媒体列表 JSON 文件拖入</p>
          <input
            ref="inputEl"
            class="local-cinema__input"
            type="file"
            :accept="ACCEPT"
            @change="onChange"
          />
        </div>
        <p v-if="error" class="local-cinema__error">{{ error }}</p>
      </div>
    </div>

    <!-- 已加载：搜索 + 海报墙 + 分页 -->
    <template v-else>
      <div class="local-cinema__toolbar">
        <input
          class="local-cinema__search"
          type="search"
          placeholder="按名称或简介搜索…"
          v-model="keyword"
        />
        <label class="local-cinema__size">
          每页
          <select :value="pageSize" @change="onChangeSize">
            <option v-for="s in PAGE_SIZE_OPTIONS" :key="s" :value="s">{{ s }}</option>
          </select>
          条
        </label>
        <label class="local-cinema__sort">
          排序
          <select :value="sortKey" @change="onSortChange">
            <option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <input
          ref="inputEl"
          class="local-cinema__input"
          type="file"
          :accept="ACCEPT"
          @change="onChange"
        />
      </div>

      <div class="local-cinema__body" ref="bodyEl">
        <div v-if="pageItems.length" class="local-cinema__grid">
          <button
            v-for="(e, i) in pageItems"
            :key="(e.raw.vod_id ?? e.raw.id ?? e.url ?? e.name ?? i) as string | number"
            class="cinema-card"
            type="button"
            :title="e.url"
            @click="openItem(e)"
          >
            <div class="cinema-card__poster">
              <img
                v-if="e.image && !imgError[imgKey(e)]"
                :src="e.image"
                :alt="e.name"
                loading="lazy"
                @error="imgError[imgKey(e)] = true"
              />
              <div v-else class="cinema-card__placeholder">🎬</div>
            </div>
            <div class="cinema-card__body">
              <h3 class="cinema-card__name">{{ e.name }}</h3>
              <div v-if="e.durationSec != null || e.publishMs != null" class="cinema-card__meta">
                <span v-if="e.durationSec != null" class="cinema-card__meta-item">{{ formatDuration(e.durationSec) }}</span>
                <span v-if="e.publishMs != null" class="cinema-card__meta-item cinema-card__meta-item--right">{{ formatDate(e.publishMs) }}</span>
              </div>
              <p v-if="e.description" class="cinema-card__desc">{{ e.description }}</p>
            </div>
          </button>
        </div>
        <p v-else class="local-cinema__empty-text">没有匹配的媒体项。</p>
      </div>

      <div
        class="local-cinema__pager"
        v-if="filtered.length > pageSize || totalPages > 1"
      >
        <button class="local-cinema__pager-btn" type="button" :disabled="page <= 1" @click="goPrev">
          上一页
        </button>
        <span class="local-cinema__pager-info">第 {{ page }} / {{ totalPages }} 页</span>
        <button
          class="local-cinema__pager-btn"
          type="button"
          :disabled="page >= totalPages"
          @click="goNext"
        >
          下一页
        </button>
        <span class="local-cinema__pager-jump">
          跳至
          <input
            class="local-cinema__pager-input"
            type="number"
            min="1"
            :max="totalPages"
            :value="page"
            @change="onJump"
          />
          页
        </span>
      </div>
    </template>
  </section>
</template>
