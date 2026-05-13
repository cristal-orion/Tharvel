<script setup lang="ts">
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth';

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
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <path d="M5 4 L5 20 M19 4 L19 20" />
        </svg>
        <span class="brand-name">Tharvel</span>
      </div>
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
  background: var(--bg-soft, #f5f5f5);
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 360px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 12px;
  padding: 28px 24px 24px;
  box-shadow: var(--shadow-md, 0 6px 24px rgba(0, 0, 0, 0.06));
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text, #111);
}
.brand-name {
  font-weight: 600;
  letter-spacing: 0.2px;
}
h1 {
  margin: 8px 0 0;
  font-size: 22px;
  font-weight: 600;
}
.sub {
  margin: 0 0 8px;
  color: var(--text-soft, #555);
  font-size: 13.5px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-soft, #444);
}
label input {
  font-size: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border, #d4d4d4);
  border-radius: 8px;
  background: var(--bg, #fff);
  color: var(--text, #111);
  outline: none;
  transition: border-color 0.15s;
}
label input:focus {
  border-color: var(--text, #111);
}
.err {
  background: #fee2e2;
  color: #991b1b;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
}
button[type='submit'] {
  margin-top: 4px;
  background: var(--text, #111);
  color: #fff;
  border: 0;
  padding: 11px 14px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}
button[type='submit']:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
