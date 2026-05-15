<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    body?: string;
    variant?: 'default' | 'compact' | 'inline';
    tone?: 'neutral' | 'brand' | 'error' | 'success' | 'warning';
  }>(),
  { variant: 'default', tone: 'neutral' },
);
</script>

<template>
  <div class="empty-state" :class="[`v-${variant}`, `t-${tone}`]">
    <div v-if="$slots.icon" class="es-icon">
      <slot name="icon" />
    </div>
    <div class="es-text">
      <div class="es-title">{{ title }}</div>
      <p v-if="body" class="es-body">{{ body }}</p>
      <slot />
    </div>
    <div v-if="$slots.actions" class="es-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  padding: 28px 20px;
  color: var(--text-soft);
}
.empty-state.v-compact {
  padding: 14px 12px;
  gap: 8px;
}
.empty-state.v-inline {
  padding: 8px 10px;
  gap: 6px;
  flex-direction: row;
  text-align: left;
  align-items: flex-start;
}

.es-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--bg-hover);
  color: var(--text-mute);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.empty-state.v-compact .es-icon {
  width: 30px;
  height: 30px;
}
.empty-state.v-inline .es-icon {
  width: 26px;
  height: 26px;
}
.empty-state.t-brand .es-icon { background: var(--brand-soft); color: var(--brand); }
.empty-state.t-error .es-icon { background: var(--error-bg); color: var(--error); }
.empty-state.t-success .es-icon { background: var(--success-soft); color: var(--success); }
.empty-state.t-warning .es-icon { background: var(--warning-soft); color: var(--warning); }

.es-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.empty-state.v-inline .es-text { flex: 1; }

.es-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.3;
}
.empty-state.v-compact .es-title { font-size: 13px; }
.empty-state.v-inline .es-title { font-size: 12.5px; }

.es-body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-soft);
}
.empty-state.v-compact .es-body { font-size: 12px; }
.empty-state.v-inline .es-body { font-size: 11.5px; }

.es-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-top: 4px;
}
.empty-state.v-inline .es-actions { margin-top: 0; }
</style>
