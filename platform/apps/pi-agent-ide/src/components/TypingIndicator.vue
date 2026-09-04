<template>
  <!-- per dot doting animation -->
  <div class="typing">
    <span class="dot dot1"></span>
    <span class="dot dot2"></span>
    <span class="dot dot3"></span>
  </div>
</template>

<style scoped>
.typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: var(--hover-bg);
  border-radius: 12px;
  align-self: flex-start;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
  animation: bounce 1.2s infinite ease-in-out;
}
.dot1 { animation-delay: 0s; }
.dot2 { animation-delay: 0.15s; }
.dot3 { animation-delay: 0.3s; }

@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}
</style>