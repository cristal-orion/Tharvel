<script setup lang="ts">
import { onMounted } from 'vue';
import TharvelApp from './components/TharvelApp.vue';
import LoginForm from './components/LoginForm.vue';
import { useAuth } from './composables/useAuth';

const { user, loading, init } = useAuth();

// Al mount chiediamo /api/me: se il cookie di sessione è valido entriamo già
// loggati (utile per F5 dopo login). Se 401, mostriamo LoginForm.
onMounted(() => {
  init();
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
