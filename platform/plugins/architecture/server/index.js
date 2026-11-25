import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = path.join(PLUGIN_DIR, "assets");
const COLLECTIONS = [
  {
    id: "platform",
    label: "\u5E73\u53F0",
    hint: "pi-agent-platform \u81EA\u8EAB\uFF1A\u5185\u6838\u8FB9\u754C\u3001\u63D2\u4EF6\u8FD0\u884C\u671F\u3001\u6D88\u606F\u94FE\u8DEF\u3001IM \u7F51\u5173\u3001\u4F1A\u8BDD\u72B6\u6001\u673A",
    emptyHint: "\u8FD8\u6CA1\u6709\u5E73\u53F0\u67B6\u6784\u56FE",
    diagrams: [
      {
        slug: "kernel-boundary",
        label: "\u5185\u6838\u8FB9\u754C",
        hint: '\u5185\u6838 / \u5165\u53E3 / \u63D2\u4EF6\u4E09\u5206\uFF1A\u8C01\u62E5\u6709\u4F1A\u8BDD\u3001\u8C01\u62E5\u6709\u529F\u80FD\uFF0C\u5224\u636E\u662F"\u5173\u6389\u63D2\u4EF6\u4ECD\u80FD\u804A\u5B8C\u4E00\u8F6E"',
        type: "architecture",
        file: "kernel-boundary.architecture.html"
      },
      {
        slug: "plugin-runtime",
        label: "\u63D2\u4EF6\u8FD0\u884C\u671F",
        hint: "4 \u4E2A\u88C5\u8F7D\u70B9 \xD7 11 \u4E2A\u6CE8\u518C\u6269\u5C55\u70B9 + \u88C5\u8F7D/\u5378\u8F7D\u8D26\u672C",
        type: "architecture",
        file: "plugin-runtime.architecture.html"
      },
      {
        slug: "plugin-actions",
        label: "\u52A8\u4F5C\u56DB\u6295\u5F71",
        hint: "\u4E00\u4EFD handler \u7684\u56DB\u4E2A\u66B4\u9732\u9762\uFF1Areverse / service / tool / http",
        type: "dataflow",
        file: "plugin-actions.dataflow.html"
      },
      {
        slug: "request-lifecycle",
        label: "\u6D88\u606F\u94FE\u8DEF",
        hint: "\u4E00\u6761\u6D88\u606F\u7684\u5B8C\u6574\u5F80\u8FD4\uFF1A\u6D4F\u89C8\u5668 \u2192 server \u2192 worker \u2192 pi \u2192 \u4E8B\u4EF6 \u2192 \u6295\u5F71 \u2192 SSE",
        type: "sequence",
        file: "request-lifecycle.sequence.html"
      },
      {
        slug: "im-gateway",
        label: "IM \u7F51\u5173",
        hint: "IM \u662F\u63D2\u4EF6\u3001\u6E20\u9053\u4E5F\u662F\u63D2\u4EF6\uFF1A\u4F9D\u8D56\u5012\u7F6E\u600E\u4E48\u628A\u4E24\u8FB9\u89E3\u8026",
        type: "architecture",
        file: "im-gateway.architecture.html"
      },
      {
        slug: "session-lifecycle",
        label: "\u4F1A\u8BDD\u72B6\u6001\u673A",
        hint: "\u5360\u4F4D \u2192 spawn \u2192 \u5FD9/\u95F2 \u2192 \u56DE\u6536\u6216\u6062\u590D",
        type: "lifecycle",
        file: "session-lifecycle.lifecycle.html"
      }
    ]
  },
  {
    id: "pi",
    label: "pi",
    hint: "\u539F\u751F pi\uFF08@earendil-works/pi-coding-agent\uFF09\uFF1A\u6211\u4EEC\u4F9D\u8D56\u7684\u90A3\u4E00\u4FA7\u600E\u4E48\u8FD0\u8F6C",
    emptyHint: "\u8FD8\u6CA1\u6709 pi \u4FA7\u7684\u56FE",
    diagrams: [
      {
        slug: "pi-lifecycle",
        label: "\u4F1A\u8BDD\u751F\u547D\u5468\u671F",
        hint: "pi \u81EA\u5DF1\u7684 session \u751F\u547D\u5468\u671F\u4E0E\u72B6\u6001\u8FC1\u79FB",
        type: "lifecycle",
        file: "pi/pi-lifecycle.lifecycle.html"
      },
      {
        slug: "pi-events",
        label: "\u4E8B\u4EF6\u6D41",
        hint: "\u4E00\u6B21 prompt \u91CC pi \u5410\u51FA\u7684\u539F\u751F\u4E8B\u4EF6\u5E8F\u5217",
        type: "sequence",
        file: "pi/pi-events.sequence.html"
      },
      {
        slug: "pi-extension-points",
        label: "\u6269\u5C55\u70B9",
        hint: "pi \u7684\u6269\u5C55\u7CFB\u7EDF\u80FD\u6302\u4EC0\u4E48\u3001\u4EC0\u4E48\u65F6\u5019\u88AB\u8C03\u7528",
        type: "tree",
        file: "pi/pi-extension-points.tree.html"
      },
      {
        slug: "pi-session-file",
        label: "\u4F1A\u8BDD\u6587\u4EF6",
        hint: "\u4F1A\u8BDD\u843D\u76D8\u7684\u76EE\u5F55\u7ED3\u6784\u4E0E\u6587\u4EF6\u804C\u8D23",
        type: "tree",
        file: "pi/pi-session-file.tree.html"
      }
    ]
  }
];
const ALLOWED_FILES = new Set(
  COLLECTIONS.flatMap((c) => c.diagrams.map((d) => d.file))
);
const CONTENT_TYPE = "text/html; charset=utf-8";
function init(host) {
  host.ui.headerAction({
    id: "diagrams",
    icon: "architecture",
    title: "\u67B6\u6784\u56FE",
    component: "panel",
    // 与以前的硬编码图标同一个位置：插件动作按 order 排在顶栏、主题切换之前。
    order: 20
  });
  host.ui.page({
    path: "/architecture",
    label: "\u67B6\u6784\u56FE",
    icon: "architecture",
    component: "viewer",
    // 入口只在顶栏：不占导航项（同 notifications 的 `/notifications`）。
    nav: false
  });
  host.http.route({
    method: "GET",
    path: "/manifest",
    handler: () => ({
      json: {
        collections: COLLECTIONS
      }
    })
  });
  host.http.route({
    method: "GET",
    path: "/diagram/*",
    handler: (req) => {
      const file = req.params["*"];
      if (!file || !ALLOWED_FILES.has(file)) {
        return { status: 404, json: { error: "unknown diagram", file: file ?? null } };
      }
      const abs = path.resolve(ASSETS_DIR, file);
      if (!abs.startsWith(path.resolve(ASSETS_DIR) + path.sep)) {
        return { status: 400, json: { error: "bad path" } };
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return {
          status: 404,
          json: { error: "diagram not generated yet", file, hint: "\u8DD1 archify finalize \u751F\u6210 assets/" }
        };
      }
      return new Response(readFileSync(abs), {
        status: 200,
        headers: {
          "content-type": CONTENT_TYPE,
          // 产物随插件版本变化：no-cache 让重装/reload 后立刻生效，避免 iframe 拿旧的。
          "cache-control": "no-cache"
        }
      });
    }
  });
}
export {
  init
};
