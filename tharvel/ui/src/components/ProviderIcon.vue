<script setup lang="ts">
import { computed } from 'vue';
import { siClaude, siGithubcopilot } from 'simple-icons';

const props = withDefaults(
  defineProps<{
    provider: string;
    size?: number;
    /** Forza il colore di rendering ignorando il brand color (es. per stati disabled) */
    plain?: boolean;
  }>(),
  { size: 22, plain: false },
);

// OpenAI/Codex non sono in simple-icons (per policy del progetto). Uso un
// glyph "sparkle/AI" come fallback con il brand-color OpenAI verde.
// OpenCode non ha icona ufficiale: uso `</>` codepath.
const SPARKLE_PATH =
  'M12 3 L13.5 9.5 L20 11 L13.5 12.5 L12 19 L10.5 12.5 L4 11 L10.5 9.5 Z M18 4 L18.6 6.4 L21 7 L18.6 7.6 L18 10 L17.4 7.6 L15 7 L17.4 6.4 Z';
const CODE_PATH =
  'M8 18 L2 12 L8 6 M16 6 L22 12 L16 18 M14 4 L10 20';

interface IconDef {
  path: string;
  hex: string;
}

const ICONS: Record<string, IconDef> = {
  anthropic: { path: siClaude.path, hex: siClaude.hex },
  'github-copilot': { path: siGithubcopilot.path, hex: siGithubcopilot.hex },
  // openai-codex e openai: stessa origine, uso brand color OpenAI verde-acqua
  'openai-codex': { path: SPARKLE_PATH, hex: '10A37F' },
  openai: { path: SPARKLE_PATH, hex: '10A37F' },
  // opencode: fallback "code" — viola coerente con il gradient esistente
  opencode: { path: CODE_PATH, hex: '6366F1' },
  'opencode-go': { path: CODE_PATH, hex: '8B5CF6' },
};

const FALLBACK: IconDef = { path: 'M12 2 L22 8 V16 L12 22 L2 16 V8 Z', hex: '888888' };

const ic = computed<IconDef>(() => ICONS[props.provider] ?? FALLBACK);
const stroke = computed(() => props.provider === 'opencode' || props.provider === 'opencode-go');
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :style="{ color: plain ? 'currentColor' : '#' + ic.hex }"
    :fill="stroke ? 'none' : 'currentColor'"
    :stroke="stroke ? 'currentColor' : 'none'"
    :stroke-width="stroke ? 2 : 0"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="ic.path" />
  </svg>
</template>
