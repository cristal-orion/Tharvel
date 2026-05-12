<script setup lang="ts">
import { ref } from 'vue';
import type { ProjectFile } from '../composables/useTharvelSession';

defineProps<{
  files: ProjectFile[];
  selected: string[];
  isConnected: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:selected', val: string[]): void;
  (e: 'open-settings'): void;
  (e: 'clear-chat'): void;
}>();

const projectsOpen = ref(true);
const assetsOpen = ref(true);

const toggle = (path: string, current: string[]) => {
  const idx = current.indexOf(path);
  if (idx >= 0) emit('update:selected', current.filter((p) => p !== path));
  else emit('update:selected', [...current, path]);
};
</script>

<template>
  <aside class="sidebar">
    <header class="sidebar-top">
      <div class="brand">
        <div class="logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M5 4 L5 20 M19 4 L19 20" />
          </svg>
        </div>
        <span class="brand-name">Tharvel</span>
        <span class="brand-tag">alpha</span>
      </div>
    </header>

    <div class="sidebar-body">
      <section class="section">
        <button class="section-header" @click="projectsOpen = !projectsOpen">
          <svg class="caret" :class="{ open: projectsOpen }" width="10" height="10" viewBox="0 0 10 10">
            <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
          </svg>
          <span>Progetti</span>
        </button>
        <div v-if="projectsOpen" class="section-body">
          <div class="project-row active">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 7 L10 7 L12 5 L21 5 L21 19 L3 19 Z" />
            </svg>
            <span>site</span>
          </div>
        </div>
      </section>

      <section class="section">
        <button class="section-header" @click="assetsOpen = !assetsOpen">
          <svg class="caret" :class="{ open: assetsOpen }" width="10" height="10" viewBox="0 0 10 10">
            <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
          </svg>
          <span>Assets</span>
          <span class="count">{{ files.length }}</span>
        </button>
        <div v-if="assetsOpen" class="section-body">
          <div v-if="files.length === 0" class="empty">Nessun asset.</div>
          <label v-for="f in files" :key="f.path" class="file-row">
            <input
              type="checkbox"
              :checked="selected.includes(f.path)"
              @change="toggle(f.path, selected)"
            />
            <span class="file-name" :title="f.name">{{ f.name }}</span>
          </label>
        </div>
      </section>
    </div>

    <footer class="sidebar-bottom">
      <button class="ghost-btn" @click="emit('clear-chat')" title="Cancella chat">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6 H21 M8 6 V4 H16 V6 M6 6 L7 20 H17 L18 6" />
        </svg>
      </button>
      <button class="ghost-btn settings" @click="emit('open-settings')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19 12 a7 7 0 0 1 -.1 1.2 l1.8 1.4 -2 3.5 -2.2 -.8 a7 7 0 0 1 -2.1 1.2 l-.4 2.3 h-4 l-.4 -2.3 a7 7 0 0 1 -2.1 -1.2 l-2.2 .8 -2 -3.5 1.8 -1.4 a7 7 0 0 1 0 -2.4 l-1.8 -1.4 2 -3.5 2.2 .8 a7 7 0 0 1 2.1 -1.2 l.4 -2.3 h4 l.4 2.3 a7 7 0 0 1 2.1 1.2 l2.2 -.8 2 3.5 -1.8 1.4 a7 7 0 0 1 .1 1.2 z" />
        </svg>
        <span>Impostazioni</span>
      </button>
      <div class="conn-dot" :class="{ on: isConnected }" :title="isConnected ? 'Connesso' : 'Disconnesso'"></div>
    </footer>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 240px;
  background: var(--bg-soft);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-top {
  padding: 16px;
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo {
  display: grid;
  place-items: center;
  color: var(--text);
}
.brand-name {
  font-weight: 600;
  font-size: 14px;
}
.brand-tag {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-mute);
  background: var(--bg-hover);
  border: 1px solid var(--border);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
}

.sidebar-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
}

.section + .section {
  margin-top: 4px;
}

.section-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: transparent;
  border: 0;
  color: var(--text-mute);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.section-header:hover { color: var(--text-soft); }
.caret {
  transition: transform 0.15s;
  flex-shrink: 0;
}
.caret.open { transform: rotate(90deg); }
.count {
  margin-left: auto;
  color: var(--text-mute);
  font-weight: 500;
  font-size: 11px;
}

.section-body {
  padding: 4px 8px 8px 8px;
}

.project-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-soft);
  cursor: pointer;
}
.project-row:hover { background: var(--bg-hover); color: var(--text); }
.project-row.active { background: var(--bg-active); color: var(--text); font-weight: 500; }

.empty {
  padding: 8px 12px;
  color: var(--text-mute);
  font-size: 12px;
  font-style: italic;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-soft);
  cursor: pointer;
  user-select: none;
}
.file-row:hover { background: var(--bg-hover); color: var(--text); }
.file-row input[type="checkbox"] {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--text);
  cursor: pointer;
}
.file-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.sidebar-bottom {
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 6px;
}
.ghost-btn {
  background: transparent;
  border: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-soft);
  font-size: 13px;
}
.ghost-btn:hover { background: var(--bg-hover); color: var(--text); }
.ghost-btn.settings { flex: 1; }
.conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--error);
  margin-left: auto;
  flex-shrink: 0;
}
.conn-dot.on { background: var(--success); }
</style>
