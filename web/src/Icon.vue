<script setup>
defineProps({ name: String, size: { type: [Number, String], default: 22 } })
const paths = {
  leaf: 'M20 4C9 3 3 7 5 15c2 8 13 6 15-11ZM7 18l8-9',
  home: 'm3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10',
  book: 'M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3ZM12 6v15',
  layers: 'm12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5',
  chart: 'M4 3v17h17M8 15l4-5 4 2 5-7',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  back: 'M20 12H4m6-6-6 6 6 6',
  down: 'm6 9 6 6 6-6',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  unsure: 'M9 7a3 3 0 0 1 6 1c0 3-3 3-3 6M12 18v.1',
  sound: 'M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  search: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 2',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 3-1 4-5 2-3-2-4-1-2-5 2-3 1-4Z',
  undo: 'M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12h-3',
  spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  shield: 'm12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Zm-5 9 4 4 6-7',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9 8a3 3 0 0 1 6 0c0 3-3 3-3 6m0 4v.1',
  heart: 'M12 21 3 12C-3 4 7-1 12 6c5-7 15-2 9 6Z',
  play: 'm8 4 12 8-12 8Z',
  more: 'M5 12h.1m6.9 0h.1m6.9 0h.1'
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.leaf" /></svg></template>
