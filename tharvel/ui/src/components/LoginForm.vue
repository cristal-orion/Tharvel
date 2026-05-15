<script setup lang="ts">
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth';
import logoExtended from '../assets/logo-extended.png';

const { login, error } = useAuth();
const email = ref('');
const password = ref('');
const submitting = ref(false);

async function onSubmit() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await login(email.value.trim(), password.value);
    // useAuth aggiorna user reactive → App.vue switcha automaticamente a TharvelApp.
  } catch {
    // error reattivo già popolato dal composable
    password.value = '';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <form class="login-card" @submit.prevent="onSubmit">
      <img :src="logoExtended" alt="Tharvel" class="brand-logo" />
      <h1>Accedi</h1>
      <p class="sub">Inserisci le credenziali per modificare il tuo sito.</p>

      <label>
        <span>Email</span>
        <input
          v-model="email"
          type="email"
          required
          autocomplete="email"
          autofocus
          :disabled="submitting"
          placeholder="tu@dominio.it"
        />
      </label>
      <label>
        <span>Password</span>
        <input
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
          :disabled="submitting"
        />
      </label>

      <div v-if="error" class="err">{{ error }}</div>

      <button type="submit" :disabled="submitting || !email || !password">
        {{ submitting ? 'Accesso in corso…' : 'Accedi' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg-soft);
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 360px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 28px 24px 24px;
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.brand-logo {
  display: block;
  height: 32px;
  width: auto;
  align-self: flex-start;
  filter: var(--logo-filter, none);
}
h1 {
  margin: 8px 0 0;
  font-size: 22px;
  font-weight: 600;
}
.sub {
  margin: 0 0 8px;
  color: var(--text-soft);
  font-size: 13.5px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-soft);
}
label input {
  font-size: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  outline: none;
  transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
label input:focus {
  border-color: var(--text);
}
.err {
  background: var(--error-bg);
  color: var(--error-text);
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 13px;
}
button[type='submit'] {
  margin-top: 4px;
  background: var(--accent);
  color: var(--on-accent);
  border: 0;
  padding: 11px 14px;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--t-fast), opacity var(--t-fast);
}
button[type='submit']:hover:not(:disabled) {
  background: var(--accent-hover);
}
button[type='submit']:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
