<script setup lang="ts">
import logoMark from '../assets/logo-mark.png';

defineEmits<{
  (e: 'pick', text: string): void;
}>();

defineProps<{
  isConnected: boolean;
}>();

const suggestions = [
  'Cambia il testo del titolo principale',
  'Migliora i colori del bottone CTA',
  'Aggiungi una sezione FAQ in fondo alla pagina',
  'Rendi il sito più leggibile su mobile',
];
</script>

<template>
  <div class="welcome">
    <div class="hello">
      <img :src="logoMark" alt="Tharvel" class="welcome-logo" />
      <h3>Cosa vuoi modificare?</h3>
      <p>
        Scrivi una richiesta a parole tue, oppure usa
        <kbd>Alt</kbd>+click sul sito per selezionare un elemento da cambiare.
      </p>
    </div>

    <div class="prompts">
      <div class="prompts-label">Prova subito</div>
      <button
        v-for="(s, i) in suggestions"
        :key="i"
        class="chip"
        :disabled="!isConnected"
        @click="$emit('pick', s)"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <path d="M5 12 H19 M13 6 L19 12 L13 18" />
        </svg>
        <span>{{ s }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px 4px;
}

.hello {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
}
.welcome-logo {
  display: block;
  height: 36px;
  width: auto;
  filter: var(--logo-filter, none);
}
.hello h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.hello p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-soft);
  line-height: 1.55;
  max-width: 280px;
}
.hello kbd {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-soft);
}

.prompts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.prompts-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-mute);
  font-weight: 600;
  margin-left: 4px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: var(--text-soft);
  font-size: 12.5px;
  line-height: 1.4;
  transition: all var(--t-fast);
}
.chip:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--brand);
  color: var(--text);
}
.chip svg { color: var(--brand); flex-shrink: 0; }
.chip span { flex: 1; }
.chip:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
