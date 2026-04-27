<template>
  <svg class="k-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="24" height="24">
    <!-- 卡巴拉生命树 (Sephiroth Tree of Life) -->
    <!-- 22 条路径（连线） -->
    <g fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round">
      <!-- 中柱 -->
      <line x1="512" y1="128" x2="512" y2="320"/>
      <line x1="512" y1="320" x2="512" y2="512"/>
      <line x1="512" y1="512" x2="512" y2="704"/>
      <line x1="512" y1="704" x2="512" y2="896"/>
      <!-- 左柱 -->
      <line x1="256" y1="256" x2="256" y2="512"/>
      <line x1="256" y1="512" x2="256" y2="768"/>
      <!-- 右柱 -->
      <line x1="768" y1="256" x2="768" y2="512"/>
      <line x1="768" y1="512" x2="768" y2="768"/>
      <!-- 横向连接 -->
      <line x1="256" y1="256" x2="512" y2="320"/>
      <line x1="768" y1="256" x2="512" y2="320"/>
      <line x1="256" y1="512" x2="512" y2="512"/>
      <line x1="768" y1="512" x2="512" y2="512"/>
      <line x1="256" y1="768" x2="512" y2="704"/>
      <line x1="768" y1="768" x2="512" y2="704"/>
      <!-- 对角连接 -->
      <line x1="256" y1="256" x2="512" y2="128"/>
      <line x1="768" y1="256" x2="512" y2="128"/>
      <line x1="256" y1="512" x2="512" y2="704"/>
      <line x1="768" y1="512" x2="512" y2="704"/>
      <line x1="256" y1="768" x2="512" y2="896"/>
      <line x1="768" y1="768" x2="512" y2="896"/>
    </g>
    <!-- 10 个 Sephiroth（质点） -->
    <g fill="currentColor">
      <circle cx="512" cy="128" r="56"/>
      <circle cx="256" cy="256" r="56"/>
      <circle cx="768" cy="256" r="56"/>
      <circle cx="512" cy="320" r="56"/>
      <circle cx="256" cy="512" r="56"/>
      <circle cx="768" cy="512" r="56"/>
      <circle cx="512" cy="512" r="56"/>
      <circle cx="256" cy="768" r="56"/>
      <circle cx="768" cy="768" r="56"/>
      <circle cx="512" cy="704" r="56"/>
      <circle cx="512" cy="896" r="56"/>
    </g>
  </svg>
</template>
