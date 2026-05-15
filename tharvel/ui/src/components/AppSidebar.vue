<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ProjectFile } from '../composables/useTharvelSession';
import type { SessionUser } from '../composables/useAuth';
import HistoryPanel from './HistoryPanel.vue';
import { useTheme } from '../composables/useTheme';
import { useResizable } from '../composables/useResizable';
import logoExtended from '../assets/logo-extended.png';
import logoMark from '../assets/logo-mark.png';

interface SiteSummary {
  id: number;
  slug: string;
  domain: string | null;
  framework: 'html' | 'astro';
}

const props = defineProps<{
  files: ProjectFile[];
  selected: string[];
  isConnected: boolean;
  user: SessionUser | null;
  adminSites: SiteSummary[];
  activeSlug: string | null;
  sitesLoading: boolean;
  historyNonce: number;
  collapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:selected', val: string[]): void;
  (e: 'open-settings'): void;
  (e: 'clear-chat'): void;
  (e: 'select-site', slug: string): void;
  (e: 'add-site'): void;
  (e: 'logout'): void;
  (e: 'reload-preview'): void;
  (e: 'toggle-collapse'): void;
}>();

const sitesOpen = ref(true);
const assetsOpen = ref(true);
const historyOpen = ref(true);

const { theme, resolved, cycleTheme } = useTheme();

const resize = useResizable({
  storageKey: 'tharvel-sidebar-width',
  defaultPx: 240,
  minPx: 200,
  maxPx: 480,
  edge: 'right',
});

const themeLabel = computed(() =>
  theme.value === 'system' ? `Sistema (${resolved.value})` : theme.value === 'dark' ? 'Scuro' : 'Chiaro',
);

const toggle = (path: string, current: string[]) => {
  const idx = current.indexOf(path);
  if (idx >= 0) emit('update:selected', current.filter((p) => p !== path));
  else emit('update:selected', [...current, path]);
};
</script>

<template>
  <aside
    class="sidebar"
    :class="{ collapsed, resizing: resize.dragging.value }"
    :style="collapsed ? undefined : { width: resize.width.value + 'px' }"
  >
    <header class="sidebar-top">
      <button
        class="brand"
        :title="collapsed ? 'Espandi sidebar' : 'Comprimi sidebar'"
        @click="emit('toggle-collapse')"
      >
        <img
          v-if="collapsed"
          :src="logoMark"
          alt="Tharvel"
          class="brand-img mark"
        />
        <img
          v-else
          :src="logoExtended"
          alt="Tharvel"
          class="brand-img extended"
        />
        <span v-if="!collapsed" class="brand-tag">{{ user?.role === 'admin' ? 'admin' : 'alpha' }}</span>
      </button>
      <button
        class="collapse-btn"
        :title="collapsed ? 'Espandi sidebar' : 'Comprimi sidebar'"
        @click="emit('toggle-collapse')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path :d="collapsed ? 'M9 6 L15 12 L9 18' : 'M15 6 L9 12 L15 18'" />
        </svg>
      </button>
    </header>

    <!-- Rail mode: solo icone essenziali al centro -->
    <div v-if="collapsed" class="rail-body">
      <button
        v-if="user?.role === 'admin'"
        class="rail-btn"
        title="Aggiungi sito"
        @click="emit('add-site')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <path d="M12 5 V19 M5 12 H19" />
        </svg>
      </button>
      <div
        v-for="s in adminSites"
        :key="s.id"
        class="rail-site"
        :class="{ active: s.slug === activeSlug }"
        @click="emit('select-site', s.slug)"
      >
        {{ s.slug.slice(0, 1).toUpperCase() }}
        <div class="rich-tip" role="tooltip">
          <div class="tip-title">{{ s.slug }}</div>
          <div class="tip-meta">
            <span class="tip-domain">{{ s.domain ?? 'nessun dominio' }}</span>
            <span class="tip-fw">{{ s.framework }}</span>
          </div>
          <div class="tip-status" :class="{ on: s.slug === activeSlug && isConnected }">
            <span class="dot"></span>
            <span v-if="s.slug === activeSlug && isConnected">Sito attivo · live</span>
            <span v-else-if="s.slug === activeSlug">Sito attivo · offline</span>
            <span v-else>Click per attivare</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Full mode -->
    <div v-else class="sidebar-body">
      <section v-if="user?.role === 'admin'" class="section">
        <button class="section-header" @click="sitesOpen = !sitesOpen">
          <svg class="caret" :class="{ open: sitesOpen }" width="10" height="10" viewBox="0 0 10 10">
            <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
          </svg>
          <span>Siti</span>
          <span class="count">{{ adminSites.length }}</span>
        </button>
        <div v-if="sitesOpen" class="section-body">
          <div v-if="sitesLoading" class="empty">Caricamento…</div>
          <div v-else-if="adminSites.length === 0" class="empty">Nessun sito ancora — crea il primo con "Aggiungi sito".</div>
          <button
            v-for="s in adminSites"
            :key="s.id"
            class="project-row"
            :class="{ active: s.slug === activeSlug }"
            @click="emit('select-site', s.slug)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 7 L10 7 L12 5 L21 5 L21 19 L3 19 Z" />
            </svg>
            <span class="site-slug">{{ s.slug }}</span>
            <span class="site-fw">{{ s.framework }}</span>
          </button>
          <button class="project-row add-site" @click="emit('add-site')" title="Onboarding nuovo sito">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M12 5 V19 M5 12 H19" />
            </svg>
            <span>Aggiungi sito…</span>
          </button>
        </div>
      </section>

      <section v-if="activeSlug" class="section">
        <button class="section-header" @click="historyOpen = !historyOpen">
          <svg class="caret" :class="{ open: historyOpen }" width="10" height="10" viewBox="0 0 10 10">
            <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
          </svg>
          <span>Storico</span>
        </button>
        <div v-if="historyOpen" class="section-body history-body">
          <HistoryPanel
            :slug="activeSlug"
            :nonce="historyNonce"
            @reload-preview="emit('reload-preview')"
          />
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
          <div v-if="files.length === 0" class="empty">Trascina un'immagine sulla preview per aggiungerla qui.</div>
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
      <div v-if="user && !collapsed" class="user-info" :title="user.email">
        <div class="avatar">{{ user.email.slice(0, 1).toUpperCase() }}</div>
        <div class="user-meta">
          <div class="user-email">{{ user.email }}</div>
          <div class="user-role">{{ user.role }}</div>
        </div>
      </div>
      <div class="footer-actions" :class="{ rail: collapsed }">
        <button class="menu-btn" @click="cycleTheme" :title="`Tema attuale: ${themeLabel}. Click per cambiare.`">
          <svg v-if="theme === 'system'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="3" y="4" width="18" height="13" rx="1.5" />
            <path d="M9 21 H15 M12 17 V21" />
          </svg>
          <svg v-else-if="theme === 'light'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2 V4 M12 20 V22 M2 12 H4 M20 12 H22 M4.9 4.9 L6.3 6.3 M17.7 17.7 L19.1 19.1 M4.9 19.1 L6.3 17.7 M17.7 6.3 L19.1 4.9" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 12.8 A9 9 0 0 1 11.2 3 a7 7 0 1 0 9.8 9.8 Z" />
          </svg>
          <span v-if="!collapsed" class="menu-label">Tema</span>
          <span v-if="!collapsed" class="menu-value">{{ themeLabel }}</span>
        </button>
        <button class="menu-btn" @click="emit('open-settings')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19 12 a7 7 0 0 1 -.1 1.2 l1.8 1.4 -2 3.5 -2.2 -.8 a7 7 0 0 1 -2.1 1.2 l-.4 2.3 h-4 l-.4 -2.3 a7 7 0 0 1 -2.1 -1.2 l-2.2 .8 -2 -3.5 1.8 -1.4 a7 7 0 0 1 0 -2.4 l-1.8 -1.4 2 -3.5 2.2 .8 a7 7 0 0 1 2.1 -1.2 l.4 -2.3 h4 l.4 2.3 a7 7 0 0 1 2.1 1.2 l2.2 -.8 2 3.5 -1.8 1.4 a7 7 0 0 1 .1 1.2 z" />
          </svg>
          <span v-if="!collapsed" class="menu-label">Impostazioni</span>
        </button>
        <button class="menu-btn danger" @click="emit('logout')" title="Esci dalla sessione">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M9 21 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 h4 M16 17 l5 -5 -5 -5 M21 12 H9" />
          </svg>
          <span v-if="!collapsed" class="menu-label">Esci</span>
        </button>
      </div>
    </footer>

    <div
      v-if="!collapsed"
      class="resize-handle"
      :class="{ active: resize.dragging.value }"
      @pointerdown="resize.onPointerDown"
      role="separator"
      aria-orientation="vertical"
      aria-label="Ridimensiona sidebar"
    ></div>
  </aside>
</template>

<style scoped>
.sidebar {
  background: var(--bg-soft);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
  transition: width var(--t-base);
}
.sidebar.resizing {
  transition: none;
}
.sidebar.collapsed {
  width: 56px !important;
}

.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background var(--t-fast);
}
.resize-handle:hover,
.resize-handle.active {
  background: var(--brand-soft);
}

.sidebar-top {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 4px;
}
.sidebar.collapsed .sidebar-top {
  flex-direction: column;
  padding: 12px 8px 10px;
  gap: 8px;
}
.sidebar.collapsed .collapse-btn {
  width: 100%;
  border: 1px solid var(--border);
  background: var(--bg);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 0;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  flex: 1;
  text-align: left;
  color: var(--text);
  transition: background var(--t-fast);
  min-width: 0;
}
.brand:hover { background: var(--bg-hover); }
.sidebar.collapsed .brand { flex: 0 0 auto; padding: 6px; }

.brand-img {
  display: block;
  height: 38px;
  width: auto;
  flex-shrink: 0;
  filter: var(--logo-filter, none);
}
.brand-img.mark {
  height: 34px;
}
.brand-tag {
  margin-left: auto;
  font-size: 11px;
  color: var(--brand);
  background: var(--brand-soft);
  border: 1px solid var(--brand-soft);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
}

.collapse-btn {
  background: transparent;
  border: 0;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  color: var(--text-mute);
  border-radius: 4px;
  transition: background var(--t-fast), color var(--t-fast);
}
.collapse-btn:hover { background: var(--bg-hover); color: var(--text); }

.sidebar-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
}

.rail-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 6px;
  overflow-y: auto;
}
.rail-btn {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--text-mute);
  display: grid;
  place-items: center;
  transition: all var(--t-fast);
}
.rail-btn:hover { border-style: solid; border-color: var(--text); color: var(--text); }
.rail-site {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-soft);
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--t-fast);
  user-select: none;
}
.rail-site:hover { background: var(--bg-active); color: var(--text); }
.rail-site.active {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 0 0 2px var(--brand-soft);
}

.rich-tip {
  position: absolute;
  left: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 9px 12px;
  box-shadow: var(--shadow-lg);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  z-index: 200;
  transition: opacity var(--t-fast), transform var(--t-fast);
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rich-tip::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 50%;
  transform: translateY(-50%) rotate(45deg);
  width: 8px;
  height: 8px;
  background: var(--bg);
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.rail-site:hover .rich-tip {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
.tip-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.tip-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-mute);
}
.tip-domain { color: var(--text-soft); }
.tip-fw {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 3px;
}
.tip-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-mute);
  padding-top: 4px;
  border-top: 1px dashed var(--border);
}
.tip-status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-mute);
}
.tip-status.on { color: var(--success); }
.tip-status.on .dot {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
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
  transition: color var(--t-fast);
}
.section-header:hover { color: var(--text-soft); }
.caret {
  transition: transform var(--t-fast);
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
.history-body { padding: 4px 6px 8px 6px; }

.project-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-soft);
  cursor: pointer;
  background: transparent;
  border: 0;
  width: 100%;
  text-align: left;
  transition: background var(--t-fast), color var(--t-fast);
}
.project-row:hover { background: var(--bg-hover); color: var(--text); }
.project-row.active { background: var(--bg-active); color: var(--text); font-weight: 500; }
.site-slug { flex: 1; }
.site-fw {
  font-size: 10.5px;
  color: var(--text-mute);
  font-family: var(--font-mono);
  text-transform: uppercase;
}
.add-site {
  color: var(--text-mute);
  font-style: italic;
  margin-top: 4px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.add-site:hover { color: var(--text); font-style: normal; }

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
  transition: background var(--t-fast), color var(--t-fast);
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
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.user-info {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.user-meta {
  flex: 1;
  min-width: 0;
}
.user-email {
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-role {
  font-size: 10.5px;
  color: var(--text-mute);
  font-family: var(--font-mono);
  text-transform: uppercase;
}
.footer-actions {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.footer-actions.rail {
  padding: 8px 4px;
  align-items: center;
}

.menu-btn {
  background: transparent;
  border: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-soft);
  font-size: 13px;
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
  width: 100%;
  text-align: left;
}
.menu-btn:hover { background: var(--bg-hover); color: var(--text); }
.menu-btn.danger:hover { color: var(--error); }
.menu-btn svg { flex-shrink: 0; color: var(--text-mute); transition: color var(--t-fast); }
.menu-btn:hover svg { color: inherit; }
.menu-label { flex: 1; }
.menu-value {
  font-size: 11.5px;
  color: var(--text-mute);
  font-family: var(--font-mono);
  text-transform: lowercase;
}
.footer-actions.rail .menu-btn {
  width: 36px;
  height: 36px;
  padding: 0;
  justify-content: center;
}
.footer-actions.rail .menu-btn .menu-label,
.footer-actions.rail .menu-btn .menu-value { display: none; }
</style>
