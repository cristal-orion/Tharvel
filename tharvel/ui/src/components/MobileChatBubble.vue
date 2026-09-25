<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{ processing: boolean; connected: boolean; unread: boolean }>();
const emit = defineEmits<{ (e: 'open'): void }>();
const layer = ref<HTMLElement | null>(null);
const x = ref(0);
const y = ref(0);
const dragging = ref(false);
let side = 'right';
let fraction = 0.9;
try {
  const saved = JSON.parse(localStorage.getItem('tharvel-mobile-bubble') || 'null');
  if (saved?.side === 'left' || saved?.side === 'right') side = saved.side;
  if (Number.isFinite(saved?.fraction)) fraction = Math.max(0, Math.min(1, saved.fraction));
} catch { /* Storage may be unavailable in private browsing. */ }

const label = computed(() => !props.connected ? 'Apri chat · Non connessa' : props.processing
  ? 'Apri chat · Elaborazione in corso' : props.unread ? 'Apri chat · Nuova risposta' : 'Apri chat');
const limits = () => ({ x: Math.max(0, (layer.value?.clientWidth ?? 56) - 56), y: Math.max(0, (layer.value?.clientHeight ?? 56) - 56) });
function place() {
  const bounds = limits();
  x.value = side === 'left' ? 0 : bounds.x;
  y.value = fraction * bounds.y;
}
let start: { x: number; y: number; left: number; top: number } | null = null;
let moved = false;
function down(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return;
  start = { x: event.clientX, y: event.clientY, left: x.value, top: y.value };
  moved = false;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!start) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (Math.hypot(dx, dy) > 8) moved = true;
  if (!moved) return;
  dragging.value = true;
  const bounds = limits();
  x.value = Math.max(0, Math.min(bounds.x, start.left + dx));
  y.value = Math.max(0, Math.min(bounds.y, start.top + dy));
}
function up() {
  if (!start) return;
  start = null;
  dragging.value = false;
  const bounds = limits();
  side = x.value < bounds.x / 2 ? 'left' : 'right';
  fraction = bounds.y ? Math.max(0, Math.min(1, y.value / bounds.y)) : 0.9;
  place();
  try { localStorage.setItem('tharvel-mobile-bubble', JSON.stringify({ side, fraction })); } catch { /* optional preference */ }
}
function click(event: MouseEvent) {
  if (!moved || event.detail === 0) emit('open');
  moved = false;
}
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(place);
  if (layer.value) observer.observe(layer.value);
  place();
});
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div ref="layer" class="bubble-layer">
    <button class="chat-bubble" :class="{ dragging, processing, offline: !connected }"
      :style="{ transform: `translate(${x}px, ${y}px)` }" :aria-label="label" :title="label"
      aria-controls="tharvel-chat" aria-expanded="false"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up" @contextmenu.prevent @click="click">
      <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2A8.5 8.5 0 0 1 21 11.5Z" />
        <path d="M7 10h9M7 14h5" />
      </svg>
      <span v-if="unread || processing || !connected" class="bubble-status" aria-hidden="true">{{ !connected ? '!' : processing ? '…' : '1' }}</span>
    </button>
    <span class="sr-only" role="status">{{ label }}</span>
  </div>
</template>

<style scoped>
.bubble-layer {
  position: fixed;
  top: calc(var(--visual-top, 0px) + env(safe-area-inset-top) + 72px);
  height: max(56px, calc(var(--visual-height, 100dvh) - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 88px));
  left: max(12px, env(safe-area-inset-left));
  right: max(12px, env(safe-area-inset-right));
  pointer-events: none;
  z-index: 40;
}
.chat-bubble {
  width: 56px; height: 56px; border-radius: 50%; border: 1px solid rgba(255,255,255,.3);
  background: var(--brand); color: white; box-shadow: var(--shadow-lg);
  display: grid; place-items: center; position: absolute; top: 0; left: 0;
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
  cursor: grab;
}
.chat-bubble.dragging { cursor: grabbing; }
.bubble-status {
  position: absolute; right: -2px; top: -2px; min-width: 22px; height: 22px;
  display: grid; place-items: center; border-radius: 50%; border: 2px solid var(--bg);
  background: var(--accent); color: var(--on-accent); font-size: 12px; font-weight: 700;
}
.offline .bubble-status { background: var(--error); color: white; }
.processing .bubble-status { animation: pulse 1.5s infinite; }
@keyframes pulse { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) {
  .chat-bubble { transition: none; }
  .processing .bubble-status { animation: none; }
}
</style>
