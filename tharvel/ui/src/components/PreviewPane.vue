<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SelectedElement } from '../composables/useTharvelSession';
import { buildSiteBase } from '../site';

const props = defineProps<{
  slug: string;
  iframeNonce: number;
  selectedElement: SelectedElement | null;
}>();

const emit = defineEmits<{
  (e: 'clear-element'): void;
}>();

type Device = 'desktop' | 'tablet' | 'mobile';
const device = ref<Device>('desktop');

const iframeSrc = computed(
  () => `${buildSiteBase(props.slug)}/index.html?_=${props.iframeNonce}`
);

const widths: Record<Device, string> = {
  desktop: '100%',
  tablet: '780px',
  mobile: '390px',
};
</script>

<template>
  <main class="preview">
    <header class="preview-bar">
      <div class="bar-left">
        <span class="path">site</span>
        <span class="path-sep">/</span>
        <span class="path-leaf">index.html</span>
      </div>

      <div class="device-tabs">
        <button :class="{ active: device === 'desktop' }" @click="device = 'desktop'" title="Desktop">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="12" rx="1.5" />
            <path d="M9 20 H15 M12 16 V20" />
          </svg>
        </button>
        <button :class="{ active: device === 'tablet' }" @click="device = 'tablet'" title="Tablet">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="6" y="3" width="12" height="18" rx="1.5" />
            <circle cx="12" cy="18" r="0.8" fill="currentColor" />
          </svg>
        </button>
        <button :class="{ active: device === 'mobile' }" @click="device = 'mobile'" title="Mobile">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="7" y="3" width="10" height="18" rx="1.5" />
            <circle cx="12" cy="18" r="0.7" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div class="bar-right">
        <span class="hint">
          <kbd>Alt</kbd> + click per selezionare un elemento
        </span>
        <button class="publish">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M5 12 L9 16 L19 6" />
          </svg>
          Pubblica
        </button>
      </div>
    </header>

    <div class="preview-stage">
      <div class="frame-wrap" :style="{ maxWidth: widths[device] }">
        <iframe
          :src="iframeSrc"
          class="frame"
          frameborder="0"
        />
      </div>
    </div>

    <transition name="chip">
      <div v-if="selectedElement" class="element-chip">
        <span class="chip-dot"></span>
        <code>
          {{ selectedElement.tag }}<template v-if="selectedElement.id">#{{ selectedElement.id }}</template><template v-if="selectedElement.classes">.{{ selectedElement.classes.split(' ')[0] }}</template>
        </code>
        <span class="chip-text" v-if="selectedElement.text">"{{ selectedElement.text.slice(0, 40) }}{{ selectedElement.text.length > 40 ? '…' : '' }}"</span>
        <button class="chip-x" @click="emit('clear-element')" title="Deseleziona">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
      </div>
    </transition>
  </main>
</template>

<style scoped>
.preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-soft);
  position: relative;
  min-width: 0;
}

.preview-bar {
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  gap: 16px;
}

.bar-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-soft);
  flex: 1;
  min-width: 0;
}
.path-sep { color: var(--text-mute); }
.path-leaf { color: var(--text); font-weight: 500; }

.device-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-hover);
  padding: 2px;
  border-radius: var(--radius-sm);
}
.device-tabs button {
  background: transparent;
  border: 0;
  padding: 5px 10px;
  border-radius: 4px;
  color: var(--text-mute);
  display: grid;
  place-items: center;
}
.device-tabs button:hover { color: var(--text-soft); }
.device-tabs button.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}

.bar-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  justify-content: flex-end;
}
.hint {
  font-size: 12px;
  color: var(--text-mute);
}
kbd {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-soft);
}
.publish {
  background: var(--text);
  color: white;
  border: 0;
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.15s;
}
.publish:hover { background: #000; }

.preview-stage {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: stretch;
  padding: 24px;
  overflow: auto;
}
.frame-wrap {
  width: 100%;
  height: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  overflow: hidden;
  transition: max-width 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.frame {
  width: 100%;
  height: 100%;
  border: 0;
}

.element-chip {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--text);
  color: var(--bg);
  padding: 8px 12px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  box-shadow: var(--shadow-lg);
  max-width: calc(100% - 48px);
}
.chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.25);
}
.element-chip code {
  background: rgba(255,255,255,0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
}
.chip-text {
  color: rgba(255,255,255,0.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
.chip-x {
  background: transparent;
  border: 0;
  color: rgba(255,255,255,0.6);
  padding: 2px;
  display: grid;
  place-items: center;
  border-radius: 4px;
}
.chip-x:hover { color: white; background: rgba(255,255,255,0.1); }

.chip-enter-active, .chip-leave-active {
  transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.chip-enter-from, .chip-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
