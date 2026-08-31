import { createApp } from 'vue';
import App from './App.vue';
// highlight.js ships unstyled: only the .hljs / .hljs-keyword / .hljs-string
// class structure; the colors live in a separate stylesheet. We don't import
// the upstream stylesheet (hljs 10 hardcodes colors, no CSS variables), and
// instead author our own token→var mapping in style.css under :root /
// :root[data-mode="dark"], so light & dark theme each pick their palette.
import './style.css';

// pi-agent-ide: 单页 Vue 应用，无 vue-router，无 pinia。
// 所有功能（顶栏、消息流、输入框）以 Vue 组件形式组合在 App.vue 内。
const app = createApp(App);
app.mount('#app');