import { ref, watch, computed } from 'vue';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'tharvel-theme';

function readStored(): Theme {
  if (typeof localStorage === 'undefined') return 'system';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

const theme = ref<Theme>(readStored());
const systemDark = ref<boolean>(
  typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches,
);

if (typeof window !== 'undefined') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', (e) => {
    systemDark.value = e.matches;
  });
}

const resolved = computed<ResolvedTheme>(() =>
  theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value,
);

function apply() {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved.value);
}

apply();
watch(resolved, apply);

watch(theme, (t) => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, t);
});

export function useTheme() {
  function setTheme(t: Theme) {
    theme.value = t;
  }

  // Ciclo: system → light → dark → system. Il bottone single-icon
  // diventa quindi un toggle a tre stati intuitivo.
  function cycleTheme() {
    theme.value =
      theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system';
  }

  return {
    theme,
    resolved,
    setTheme,
    cycleTheme,
  };
}
