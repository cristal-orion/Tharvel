import { onMounted, onUnmounted, ref } from 'vue';

// Keep this breakpoint in sync with the compact rules in style.css.
export function useMobileLayout() {
  const query = window.matchMedia('(max-width: 1100px)');
  const compact = ref(query.matches);
  const update = () => { compact.value = query.matches; };
  onMounted(() => query.addEventListener('change', update));
  onUnmounted(() => query.removeEventListener('change', update));
  return { compact };
}

// visualViewport shrinks with the keyboard on iOS even when 100dvh does not.
// Installed once, including on the login screen and for teleported dialogs.
export function useVisualViewport() {
  const viewport = window.visualViewport;
  const update = () => {
    const root = document.documentElement;
    root.style.setProperty('--visual-height', `${viewport?.height ?? window.innerHeight}px`);
    root.style.setProperty('--visual-top', `${viewport?.offsetTop ?? 0}px`);
    root.classList.toggle('keyboard-open', (viewport?.height ?? window.innerHeight) < window.innerHeight - 120);
  };
  onMounted(() => {
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
  });
  onUnmounted(() => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
  });
}
