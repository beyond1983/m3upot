<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import LocalCinema from './components/LocalCinema.vue'
import TvLive from './components/TvLive.vue'

type Route = 'local' | 'tv'

function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '').trim()
  return h === 'tv' ? 'tv' : 'local'
}

const route = ref<Route>(readRoute())

function go(r: Route) {
  window.location.hash = r === 'tv' ? '#/tv' : '#/local'
}

function onHashChange() {
  route.value = readRoute()
}

onMounted(() => window.addEventListener('hashchange', onHashChange))
onUnmounted(() => window.removeEventListener('hashchange', onHashChange))
</script>

<template>
  <div class="app">
    <nav class="app-nav">
      <span class="app-nav__brand">🎬 M3uPot</span>
      <div class="app-nav__tabs">
        <button
          type="button"
          class="app-nav__tab"
          :class="{ 'is-active': route === 'local' }"
          @click="go('local')"
        >
          本地影院
        </button>
        <button
          type="button"
          class="app-nav__tab"
          :class="{ 'is-active': route === 'tv' }"
          @click="go('tv')"
        >
          TV 直播
        </button>
      </div>
    </nav>
    <main class="app-main">
      <LocalCinema v-show="route === 'local'" />
      <TvLive v-show="route === 'tv'" />
    </main>
  </div>
</template>
