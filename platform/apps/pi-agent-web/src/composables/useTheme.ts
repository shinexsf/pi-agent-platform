import { ref, watch } from 'vue';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'pi-agent-platform:theme';

function detect(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const theme = ref<Theme>(detect());

watch(
  theme,
  (t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem(STORAGE_KEY, t);
  },
  { immediate: true },
);

export function useTheme() {
  return {
    theme,
    toggle: () => {
      theme.value = theme.value === 'light' ? 'dark' : 'light';
    },
  };
}