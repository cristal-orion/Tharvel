<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { PROVIDERS, findProvider, parseSelected } from '../composables/providers';

const props = defineProps<{
  selected: string;
  auth: Record<string, 'connected' | 'disconnected' | 'pending'>;
}>();

const emit = defineEmits<{
  (e: 'update:selected', val: string): void;
  (e: 'open-settings'): void;
}>();

const open = ref(false);
const expanded = ref<string | null>(null);
const root = ref<HTMLElement | null>(null);

const current = computed(() => {
  const { provider, model } = parseSelected(props.selected);
  const p = findProvider(provider);
  const m = p?.models.find((mm) => mm.id === model);
  return {
    providerLabel: p?.label || provider,
    modelLabel: m?.label || model,
    providerId: provider,
  };
});

const close = () => {
  open.value = false;
  expanded.value = null;
};

const onDocClick = (e: MouseEvent) => {
  if (root.value && !root.value.contains(e.target as Node)) close();
};

const select = (provId: string, modelId: string) => {
  if (props.auth[provId] !== 'connected') {
    emit('open-settings');
    close();
    return;
  }
  emit('update:selected', `${provId}/${modelId}`);
  close();
};

onMounted(() => document.addEventListener('mousedown', onDocClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick));
</script>

<template>
  <div class="picker-root" ref="root">
    <button class="trigger" @click="open = !open">
      <span class="dot" :class="{ on: auth[current.providerId] === 'connected' }"></span>
      <span class="label">{{ current.providerLabel }}</span>
      <span class="model">{{ current.modelLabel }}</span>
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M2 4 L5 7 L8 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" />
      </svg>
    </button>

    <transition name="pop">
      <div v-if="open" class="popup">
        <div class="popup-header">Provider</div>
        <div class="popup-list">
          <div v-for="p in PROVIDERS" :key="p.id" class="prov">
            <button
              class="prov-row"
              :class="{ expanded: expanded === p.id }"
              @click="expanded = expanded === p.id ? null : p.id"
            >
              <span class="prov-icon" :data-prov="p.id"></span>
              <span class="prov-name">{{ p.label }}</span>
              <span
                class="prov-badge"
                :class="{
                  connected: auth[p.id] === 'connected',
                  pending: auth[p.id] === 'pending',
                }"
              >
                {{
                  auth[p.id] === 'connected' ? 'attivo' :
                  auth[p.id] === 'pending' ? '…' :
                  p.authMode === 'oauth' ? 'login' : 'api key'
                }}
              </span>
              <svg class="caret" :class="{ open: expanded === p.id }" width="10" height="10" viewBox="0 0 10 10">
                <path d="M3 2 L7 5 L3 8" fill="currentColor" />
              </svg>
            </button>
            <div v-if="expanded === p.id" class="prov-models">
              <button
                v-for="m in p.models"
                :key="m.id"
                class="model-row"
                :class="{ active: selected === `${p.id}/${m.id}` }"
                @click="select(p.id, m.id)"
              >
                <span class="check">
                  <svg v-if="selected === `${p.id}/${m.id}`" width="10" height="10" viewBox="0 0 10 10">
                    <path d="M2 5 L4 7 L8 3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" />
                  </svg>
                </span>
                <span>{{ m.label }}</span>
              </button>
              <button v-if="auth[p.id] !== 'connected'" class="hint-row" @click="emit('open-settings'); close()">
                {{ p.authMode === 'oauth' ? 'Effettua login →' : 'Imposta API key →' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.picker-root {
  position: relative;
}

.trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text);
  transition: background 0.15s;
}
.trigger:hover { background: var(--bg-hover); }
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-mute);
}
.dot.on { background: var(--success); }
.label { font-weight: 500; }
.model { color: var(--text-mute); }

.popup {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: 320px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  z-index: 100;
}
.popup-header {
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-mute);
  border-bottom: 1px solid var(--border);
}
.popup-list {
  max-height: 360px;
  overflow-y: auto;
  padding: 4px 0;
}

.prov-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: transparent;
  border: 0;
  font-size: 13px;
  color: var(--text);
  text-align: left;
}
.prov-row:hover { background: var(--bg-hover); }

.prov-icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--bg-active);
  flex-shrink: 0;
}
.prov-icon[data-prov="anthropic"] { background: linear-gradient(135deg, #d97757 0%, #c66a4f 100%); }
.prov-icon[data-prov="openai-codex"] { background: linear-gradient(135deg, #10a37f 0%, #0d8a6c 100%); }
.prov-icon[data-prov="github-copilot"] { background: #24292e; }
.prov-icon[data-prov="opencode"] { background: linear-gradient(135deg, #6366f1, #4f46e5); }
.prov-icon[data-prov="opencode-go"] { background: linear-gradient(135deg, #8b5cf6, #6366f1); }
.prov-icon[data-prov="openai"] { background: #10a37f; }

.prov-name { flex: 1; font-weight: 500; }
.prov-badge {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-mute);
}
.prov-badge.connected {
  background: rgba(22,163,74,0.12);
  color: var(--success);
}
.prov-badge.pending {
  background: rgba(217,119,6,0.12);
  color: var(--warning);
}
.caret { transition: transform 0.15s; color: var(--text-mute); }
.caret.open { transform: rotate(90deg); }

.prov-models {
  padding: 2px 0 6px 0;
  background: var(--bg-soft);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.model-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px 6px 38px;
  background: transparent;
  border: 0;
  font-size: 12px;
  color: var(--text-soft);
  text-align: left;
}
.model-row:hover { background: var(--bg-hover); color: var(--text); }
.model-row.active { color: var(--text); font-weight: 500; }
.check {
  width: 12px;
  display: grid;
  place-items: center;
  color: var(--success);
}
.hint-row {
  width: 100%;
  background: transparent;
  border: 0;
  padding: 6px 14px 6px 38px;
  font-size: 11px;
  color: var(--accent-soft);
  text-align: left;
}
.hint-row:hover { text-decoration: underline; }

.pop-enter-active, .pop-leave-active {
  transition: all 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pop-enter-from, .pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
