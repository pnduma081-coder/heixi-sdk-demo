<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  image: "M4 4h16v16H4z M4 15l5-5 7 10 M13 15l3-3 4 4 M16 8h.01",
  layout: "M5 3h14v18H5z M5 9h14 M10 9v12",
  layers: "M12 3L2 8l10 5 10-5-10-5z M3 12l9 5 9-5 M3 16l9 5 9-5",
  video: "M3 5h12v14H3z M15 10l6-4v12l-6-4 M7 9l4 3-4 3z",
  canvas: "M8 8c-5-5-9 5-4 8 4 3 6-5 8-8 4-6 10-1 9 3s-5 7-9 1L8 8z",
  shirt: "M8 3L2 7l3 5 3-2v11h8V10l3 2 3-5-6-4c0 5-8 5-8 0z",
  translate:
    "M3 5h12 M9 2v3 M5 5c0 6 4 10 8 11 M13 5c-1 5-4 9-10 12 M14 21l4-11 4 11 M15 18h6",
  folder: "M3 5h6l2 3h10v12H3z",
  users:
    "M16 21v-3c0-5-12-5-12 0v3 M10 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 5c5 0 5 7 0 7 M19 15c3 1 3 4 3 6",
  wallet: "M3 5h16v4H3v12h18V9H3V5z M16 13h5v4h-5z",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  code: "M8 5l-6 7 6 7 M16 5l6 7-6 7 M14 3l-4 18",
  chevron: "M9 5l7 7-7 7",
  refresh: "M20 7V2 M20 7h-5 M20 7A9 9 0 1 0 21 14",
  close: "M5 5l14 14 M5 19L19 5",
  warning: "M12 3L2 21h20L12 3z M12 9v5 M12 18h.01",
  menu: "M3 6h18 M3 12h18 M3 18h18",
  arrow: "M5 12h14 M14 7l5 5-5 5",
};
</script>
<template><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.image" /></svg></template>
