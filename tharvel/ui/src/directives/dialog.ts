import type { ObjectDirective } from 'vue';

const stack: HTMLElement[] = [];
const states = new WeakMap<HTMLElement, { previous: HTMLElement | null; key: (event: KeyboardEvent) => void }>();
const focusables = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
)).filter(node => node.getClientRects().length && !node.closest('[inert]'));

function close(el: HTMLElement) {
  const state = states.get(el);
  if (!state) return;
  document.removeEventListener('keydown', state.key);
  stack.splice(stack.indexOf(el), 1);
  states.delete(el);
  if (state.previous?.isConnected) state.previous.focus({ preventScroll: true });
}

function open(el: HTMLElement) {
  if (states.has(el)) return;
  const previous = document.activeElement as HTMLElement | null;
  const key = (event: KeyboardEvent) => {
    if (stack.at(-1) !== el) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      el.querySelector<HTMLButtonElement>('[data-dialog-close]')?.click();
    }
    if (event.key !== 'Tab') return;
    const nodes = focusables(el);
    const first = nodes[0] ?? el;
    const last = nodes.at(-1) ?? el;
    if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  };
  states.set(el, { previous, key });
  stack.push(el);
  el.tabIndex = -1;
  document.addEventListener('keydown', key);
  requestAnimationFrame(() => {
    if (states.has(el)) (el.querySelector<HTMLElement>('[data-dialog-close]') ?? el).focus({ preventScroll: true });
  });
}

export const dialog: ObjectDirective<HTMLElement, boolean> = {
  mounted: (el, binding) => { if (binding.value) open(el); },
  updated: (el, binding) => { binding.value ? open(el) : close(el); },
  beforeUnmount: close,
};
