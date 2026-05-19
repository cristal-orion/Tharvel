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

    // Overlay full-screen che cattura pointer durante il drag. Senza, l'iframe
    // della preview ingoia gli eventi quando il cursore ci passa sopra e onUp
    // non scatta più → drag "incollato" anche dopo aver rilasciato il mouse.
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;cursor:col-resize;background:transparent;user-select:none';
    document.body.appendChild(overlay);
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      // Edge 'right': il pannello è a sinistra dell'handle, drag a destra aumenta.
      // Edge 'left': il pannello è a destra dell'handle, drag a sinistra aumenta.
      const next = opts.edge === 'right' ? startW + delta : startW - delta;
      width.value = Math.max(opts.minPx, Math.min(opts.maxPx, next));
    };
    const cleanup = () => {
      dragging.value = false;
      document.body.style.userSelect = '';
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', cleanup);
      overlay.removeEventListener('pointercancel', cleanup);
      overlay.remove();
    };
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', cleanup);
    // pointercancel scatta quando il browser annulla il drag (es. perdita focus):
    // senza, lo stesso pattern dell'iframe può lasciare lo stato sporco.
    overlay.addEventListener('pointercancel', cleanup);
  }

  return {
    width,
    dragging,
    onPointerDown,
  };
}
