import { ref, watch } from 'vue';

type Edge = 'right' | 'left';

interface Options {
  storageKey: string;
  defaultPx: number;
  minPx: number;
  maxPx: number;
  edge: Edge; // su quale lato sta l'handle: 'right' → drag a destra aumenta, 'left' → drag a sinistra aumenta
}

export function useResizable(opts: Options) {
  const stored =
    typeof localStorage !== 'undefined' ? Number(localStorage.getItem(opts.storageKey)) : NaN;
  const width = ref<number>(
    Number.isFinite(stored) && stored >= opts.minPx && stored <= opts.maxPx
      ? stored
      : opts.defaultPx,
  );
  const dragging = ref(false);

  watch(width, (v) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(opts.storageKey, String(v));
  });

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    dragging.value = true;
    const startX = e.clientX;
    const startW = width.value;
    document.body.style.cursor = 'col-resize';
    // Disabilita selezione testo durante il drag.
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      // Edge 'right': il pannello è a sinistra dell'handle, drag a destra aumenta.
      // Edge 'left': il pannello è a destra dell'handle, drag a sinistra aumenta.
      const next = opts.edge === 'right' ? startW + delta : startW - delta;
      width.value = Math.max(opts.minPx, Math.min(opts.maxPx, next));
    };
    const onUp = () => {
      dragging.value = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return {
    width,
    dragging,
    onPointerDown,
  };
}
