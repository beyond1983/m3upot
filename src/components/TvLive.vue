<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'

interface TvChannel {
  id: string
  name: string
  logo: string
  group: string
  sources: string[]
}

interface TvGroup {
  title: string
  channels: TvChannel[]
}

const ACCEPT =
  '.m3u,.m3u8,application/x-mpegurl,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain'

const groups = ref<TvGroup[]>([])
const search = ref('')
const selectedGroup = ref<string>('')
const selectedId = ref<string>('')
const selectedSource = ref(0)
const error = ref<string | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const playError = ref(false)
const sidebarCollapsed = ref(false)

let hlsInstance: any = null

const hasData = computed(() => groups.value.length > 0)

const currentChannel = computed<TvChannel | null>(() => {
  if (!selectedId.value) return null
  for (const g of groups.value) {
    const c = g.channels.find((ch) => ch.id === selectedId.value)
    if (c) return c
  }
  return null
})

const channelsInGroup = computed<TvChannel[]>(() => {
  const g = groups.value.find((x) => x.title === selectedGroup.value)
  if (!g) return []
  const k = search.value.trim().toLowerCase()
  if (!k) return g.channels
  return g.channels.filter((c) => c.name.toLowerCase().includes(k))
})

function openPicker() {
  inputEl.value?.click()
}

function onChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  error.value = null
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const channels = parseM3u(String(reader.result))
      if (channels.length === 0) {
        error.value = '未在文件中解析到任何频道。'
        return
      }
      groups.value = buildGroups(channels)
      const firstGroup = groups.value[0]
      selectedGroup.value = firstGroup?.title ?? ''
      selectedId.value = firstGroup?.channels[0]?.id ?? ''
      selectedSource.value = 0
      playError.value = false
    } catch (err) {
      error.value = 'M3U 解析失败：' + (err instanceof Error ? err.message : String(err))
    }
  }
  reader.onerror = () => {
    error.value = '文件读取失败，请重试。'
  }
  reader.readAsText(f)
}

/** 解析 M3U：提取 #EXTINF 的 group-title / tvg-logo / 名称，以及随后的播放地址 */
function parseM3u(text: string): TvChannel[] {
  const lines = text.split(/\r?\n/)
  const out: TvChannel[] = []
  let pending: { name: string; logo: string; group: string } | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const group = (line.match(/group-title="([^"]*)"/i)?.[1] ?? '').trim() || '未分组'
      const logo = line.match(/tvg-logo="([^"]*)"/i)?.[1] ?? ''
      const idx = line.lastIndexOf(',')
      const name = (idx >= 0 ? line.slice(idx + 1) : line).trim() || '未命名频道'
      pending = { name, logo, group }
    } else if (line.startsWith('#')) {
      continue
    } else if (pending) {
      out.push({
        id: '',
        name: pending.name,
        logo: pending.logo,
        group: pending.group,
        sources: [line]
      })
      pending = null
    }
  }
  return out
}

/** 按 group + 频道名合并：同名同组的多个播放地址合并为多个源 */
function buildGroups(channels: TvChannel[]): TvGroup[] {
  const map = new Map<string, Map<string, TvChannel>>()
  for (const c of channels) {
    if (!map.has(c.group)) map.set(c.group, new Map())
    const inner = map.get(c.group)!
    const existing = inner.get(c.name)
    if (existing) {
      for (const s of c.sources) {
        if (!existing.sources.includes(s)) existing.sources.push(s)
      }
    } else {
      inner.set(c.name, { ...c, id: c.group + '::' + c.name })
    }
  }
  const result: TvGroup[] = []
  for (const [title, inner] of map) {
    result.push({ title, channels: [...inner.values()] })
  }
  result.sort((a, b) => {
    if (a.title === '未分组') return 1
    if (b.title === '未分组') return -1
    return a.title.localeCompare(b.title, 'zh')
  })
  return result
}

function selectGroup(title: string) {
  selectedGroup.value = title
  search.value = ''
  const g = groups.value.find((x) => x.title === title)
  selectedId.value = g?.channels[0]?.id ?? ''
  selectedSource.value = 0
  playError.value = false
}

function selectChannel(ch: TvChannel) {
  selectedId.value = ch.id
  selectedSource.value = 0
  playError.value = false
}

function selectSource(i: number) {
  selectedSource.value = i
  playError.value = false
}

function currentSrc(): string {
  const ch = currentChannel.value
  if (!ch) return ''
  return ch.sources[selectedSource.value] ?? ch.sources[0] ?? ''
}

async function playCurrent() {
  const v = videoEl.value
  const src = currentSrc()
  if (!v || !src) return

  // 切换前销毁上一次的 Hls 实例，避免多实例叠加
  if (hlsInstance) {
    hlsInstance.destroy()
    hlsInstance = null
  }
  v.pause()

  const isHls = /\.m3u8(\?.*)?$/i.test(src)
  const nativeHls = v.canPlayType('application/vnd.apple.mpegurl')

  // 桌面 Chrome 等不支持原生 HLS 时，按需动态加载 hls.js 接管 <video>
  if (isHls && !nativeHls) {
    try {
      const { default: Hls } = await import('hls.js')
      if (!Hls.isSupported()) {
        playError.value = true
        return
      }
      hlsInstance = new Hls()
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        v.play().catch(() => {
          /* 自动播放被拦截时由用户手动点击播放 */
        })
      })
      hlsInstance.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
        if (data?.fatal) playError.value = true
      })
      hlsInstance.loadSource(src)
      hlsInstance.attachMedia(v)
    } catch {
      // 动态加载失败则回退到原生（通常也无法播放，依赖外部播放器兜底）
      v.src = src
      v.load()
      v.play().catch(() => {})
    }
  } else {
    v.src = src
    v.load()
    v.play().catch(() => {
      /* 自动播放被拦截时由用户手动点击播放 */
    })
  }
}

function openExternal() {
  const src = currentSrc()
  if (src) window.open(src, '_blank', 'noopener,noreferrer')
}

function onVideoError() {
  // 由 hls.js 接管播放时不触发原生错误兜底
  if (hlsInstance) return
  playError.value = true
}

function onImgError(e: Event) {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

watch([currentChannel, selectedSource], () => {
  playError.value = false
  nextTick(playCurrent)
})

onUnmounted(() => {
  hlsInstance?.destroy()
  hlsInstance = null
})
</script>

<template>
  <section class="tv">
    <input ref="inputEl" class="tv__input" type="file" :accept="ACCEPT" @change="onChange" />

    <div v-if="!hasData" class="tv__empty">
      <div class="tv__drop" @click="openPicker">
        <div class="local-cinema__icon">📺</div>
        <p class="tv__hint">点击此处，或选择本地 M3U / M3U8 电视直播源文件</p>
        <p v-if="error" class="tv__error">{{ error }}</p>
      </div>
    </div>

    <div v-else class="tv__body" :class="{ 'is-collapsed': sidebarCollapsed }">
      <!-- 分组侧栏（可收缩） -->
      <aside class="tv__groups" :class="{ 'is-collapsed': sidebarCollapsed }">
        <button
          class="tv__collapse"
          type="button"
          :title="sidebarCollapsed ? '展开分组' : '收起分组'"
          :aria-label="sidebarCollapsed ? '展开分组' : '收起分组'"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          <svg v-if="sidebarCollapsed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18l6-6-6-6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <template v-if="!sidebarCollapsed">
          <button
            v-for="g in groups"
            :key="g.title"
            type="button"
            class="tv__group"
            :class="{ 'is-active': g.title === selectedGroup }"
            @click="selectGroup(g.title)"
          >
            <span class="tv__group-name">{{ g.title }}</span>
            <span class="tv__group-count">{{ g.channels.length }}</span>
          </button>
        </template>
      </aside>

      <!-- 频道列表 -->
      <div class="tv__list">
        <div class="tv__list-head">
          <input class="tv__search" type="search" placeholder="搜索频道…" v-model="search" />
        </div>
        <div class="tv__channels">
          <button
            v-for="ch in channelsInGroup"
            :key="ch.id"
            type="button"
            class="tv__channel"
            :class="{ 'is-active': ch.id === selectedId }"
            @click="selectChannel(ch)"
          >
            <span v-if="ch.logo" class="tv__channel-logo">
              <img
                :src="ch.logo"
                :alt="ch.name"
                loading="lazy"
                @error="onImgError"
              />
            </span>
            <span v-else class="tv__channel-noimg">📺</span>
            <span class="tv__channel-name">{{ ch.name }}</span>
            <span v-if="ch.sources.length > 1" class="tv__channel-src">源×{{ ch.sources.length }}</span>
          </button>
          <p v-if="channelsInGroup.length === 0" class="tv__list-empty">没有匹配的频道。</p>
        </div>
      </div>

      <!-- 播放区域 -->
      <div class="tv__player">
        <div class="tv__video-wrap">
          <video
            v-show="currentChannel"
            ref="videoEl"
            class="tv__video"
            controls
            autoplay
            playsinline
            @error="onVideoError"
          ></video>
          <div v-if="!currentChannel" class="tv__video-ph">
            <div class="local-cinema__icon">📺</div>
            <p>选择左侧频道开始播放</p>
          </div>
          <div v-else-if="playError" class="tv__video-ph">
            <p>当前源无法在浏览器内播放</p>
            <button class="tv__ext" type="button" @click="openExternal">用外部播放器打开</button>
          </div>
        </div>

        <div v-if="currentChannel" class="tv__info">
          <div class="tv__info-title">{{ currentChannel.name }}</div>
          <div class="tv__info-meta">
            {{ currentChannel.group }} · 共 {{ currentChannel.sources.length }} 个源
          </div>
          <div class="tv__sources">
            <button
              v-for="i in currentChannel.sources.length"
              :key="i"
              type="button"
              class="tv__source"
              :class="{ 'is-active': i - 1 === selectedSource }"
              @click="selectSource(i - 1)"
            >
              源 {{ i }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
