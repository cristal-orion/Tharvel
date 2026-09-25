<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import TharvelApp from './components/TharvelApp.vue';
import LoginForm from './components/LoginForm.vue';
import { useAuth } from './composables/useAuth';
import { useVisualViewport } from './composables/useMobileLayout';

const { user, loading, init, revalidate } = useAuth();
useVisualViewport();

const onResume = () => {
  if (document.visibilityState === 'visible') void revalidate();
};
const onPageShow = (event: PageTransitionEvent) => {
  if (event.persisted) onResume();
};

// Al mount chiediamo /api/me: se il cookie di sessione è valido entriamo già
// loggati (utile per F5 dopo login). Se 401, mostriamo LoginForm.
onMounted(() => {
  init();
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('online', onResume);
  window.addEventListener('pageshow', onPageShow);
});
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onResume);
  window.removeEventListener('online', onResume);
  window.removeEventListener('pageshow', onPageShow);
});
</script>

<template>
  <div v-if="loading" class="boot">Caricamento…</div>
  <TharvelApp v-else-if="user" />
  <LoginForm v-else />
</template>

<style scoped>
.boot {
  display: grid;
  place-items: center;
  min-height: 100vh;
  color: var(--text-soft, #666);
  font-size: 14px;
}
</style>
