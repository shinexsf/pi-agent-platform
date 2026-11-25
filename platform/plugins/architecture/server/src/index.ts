/**
 * 架构图插件（bundled）—— 顶栏入口 + 整页 iframe 宿主 + 图产物托管。
 *
 * 为什么是插件而不是 SPA 里的一页：
 * - 图是**数据**（8 张 ~840K 的自包含 HTML），不是前端代码。塞进 SPA 的 `public/`
 *   意味着每加一张图都要重新构建整个前端；插件换一张图只要换 `assets/` 里的文件 +
 *   reload 一次。
 * - 清单也只有一份：`COLLECTIONS` 就在这里。浏览器侧不硬编码任何图名，
 *   `GET /manifest` 是唯一来源。
 *
 * 三个装载点：
 * - `host.ui.headerAction` —— 顶栏图标（R11）：点开是图列表面板
 * - `host.ui.page({ nav: false })` —— 正式页面 `/architecture`（不占导航项，
 *   入口只在顶栏，跟通知插件「铃铛 → 查看全部 → /notifications」同一个形状）
 * - `host.http.route` —— 清单 JSON + HTML 产物
 *
 * 为什么产物走自己的 HTTP 路由，而不是放进 `web/`：
 * `/plugins/<id>/web/*` 的契约是「web facet 的编译产物」且只放行少数静态类型
 * （`.html` 会被 415 拒掉）；而架构图是**数据产物**。插件路由可以直接返回标准
 * `Response`，平台原样透传 —— 零平台改动就能托管静态文件。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginRouteRequest, PluginServerHost } from '@pi-agent-platform/plugin-types';

/** 插件根目录（本文件编译到 `server/index.js`，上一级就是插件根）。 */
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = path.join(PLUGIN_DIR, 'assets');

type DiagramType =
  | 'architecture'
  | 'sequence'
  | 'workflow'
  | 'dataflow'
  | 'lifecycle'
  | 'erd'
  | 'tree'
  | 'class'
  | 'timeline'
  | 'waterfall';

interface Diagram {
  /** URL 参数 `?d=`；跨集合全局唯一（老链接只带 `d=`）。 */
  slug: string;
  /** 切换器上的短标签（≤6 字）。 */
  label: string;
  /** 这张图回答什么问题。 */
  hint: string;
  type: DiagramType;
  /** `assets/` 下的相对路径（集合 `pi` 用 `pi/` 子目录）。 */
  file: string;
}

interface Collection {
  /** URL 参数 `?set=`。 */
  id: string;
  label: string;
  hint: string;
  emptyHint: string;
  diagrams: Diagram[];
}

/**
 * 图集清单 —— **唯一事实源**。
 *
 * 图源 spec 在同目录 `specs/`（archify 源，进 git），产物在 `assets/`（进 git 以便随包分发）。
 * 加一张图的流程：
 *   1. 写 `specs/<name>.<type>.json`
 *   2. `node <archify>/bin/archify.mjs finalize <type> specs/<name>.<type>.json assets/<name>.<type>.html --repo-root <仓库根> --quality showcase`
 *   3. 在下面这张表里加一行（slug 全局唯一）
 *
 * 平台集合的图都带 `sources`（仓库相对路径 + 行号）：它们是**代码证据**，
 * 不是画出来的想象。pi 集合讲的是原生 pi 的模块，靠标题里的版本号自证。
 */
const COLLECTIONS: Collection[] = [
  {
    id: 'platform',
    label: '平台',
    hint: 'pi-agent-platform 自身：内核边界、插件运行期、消息链路、IM 网关、会话状态机',
    emptyHint: '还没有平台架构图',
    diagrams: [
      {
        slug: 'kernel-boundary',
        label: '内核边界',
        hint: '内核 / 入口 / 插件三分：谁拥有会话、谁拥有功能，判据是"关掉插件仍能聊完一轮"',
        type: 'architecture',
        file: 'kernel-boundary.architecture.html',
      },
      {
        slug: 'plugin-runtime',
        label: '插件运行期',
        hint: '4 个装载点 × 11 个注册扩展点 + 装载/卸载账本',
        type: 'architecture',
        file: 'plugin-runtime.architecture.html',
      },
      {
        slug: 'plugin-actions',
        label: '动作四投影',
        hint: '一份 handler 的四个暴露面：reverse / service / tool / http',
        type: 'dataflow',
        file: 'plugin-actions.dataflow.html',
      },
      {
        slug: 'request-lifecycle',
        label: '消息链路',
        hint: '一条消息的完整往返：浏览器 → server → worker → pi → 事件 → 投影 → SSE',
        type: 'sequence',
        file: 'request-lifecycle.sequence.html',
      },
      {
        slug: 'im-gateway',
        label: 'IM 网关',
        hint: 'IM 是插件、渠道也是插件：依赖倒置怎么把两边解耦',
        type: 'architecture',
        file: 'im-gateway.architecture.html',
      },
      {
        slug: 'session-lifecycle',
        label: '会话状态机',
        hint: '占位 → spawn → 忙/闲 → 回收或恢复',
        type: 'lifecycle',
        file: 'session-lifecycle.lifecycle.html',
      },
    ],
  },
  {
    id: 'pi',
    label: 'pi',
    hint: '原生 pi（@earendil-works/pi-coding-agent）：我们依赖的那一侧怎么运转',
    emptyHint: '还没有 pi 侧的图',
    diagrams: [
      {
        slug: 'pi-lifecycle',
        label: '会话生命周期',
        hint: 'pi 自己的 session 生命周期与状态迁移',
        type: 'lifecycle',
        file: 'pi/pi-lifecycle.lifecycle.html',
      },
      {
        slug: 'pi-events',
        label: '事件流',
        hint: '一次 prompt 里 pi 吐出的原生事件序列',
        type: 'sequence',
        file: 'pi/pi-events.sequence.html',
      },
      {
        slug: 'pi-extension-points',
        label: '扩展点',
        hint: 'pi 的扩展系统能挂什么、什么时候被调用',
        type: 'tree',
        file: 'pi/pi-extension-points.tree.html',
      },
      {
        slug: 'pi-session-file',
        label: '会话文件',
        hint: '会话落盘的目录结构与文件职责',
        type: 'tree',
        file: 'pi/pi-session-file.tree.html',
      },
    ],
  },
];

/** 合法文件名白名单（防止 `..` 穿越；只允许清单里出现过的文件）。 */
const ALLOWED_FILES = new Set(
  COLLECTIONS.flatMap((c) => c.diagrams.map((d) => d.file)),
);

const CONTENT_TYPE = 'text/html; charset=utf-8';

export function init(host: PluginServerHost): void {
  host.ui.headerAction({
    id: 'diagrams',
    icon: 'architecture',
    title: '架构图',
    component: 'panel',
    // 与以前的硬编码图标同一个位置：插件动作按 order 排在顶栏、主题切换之前。
    order: 20,
  });

  host.ui.page({
    path: '/architecture',
    label: '架构图',
    icon: 'architecture',
    component: 'viewer',
    // 入口只在顶栏：不占导航项（同 notifications 的 `/notifications`）。
    nav: false,
  });

  host.http.route({
    method: 'GET',
    path: '/manifest',
    handler: () => ({
      json: {
        collections: COLLECTIONS,
      },
    }),
  });

  // 用 `*` 而不是 `:file`：`pi/xxx.html` 这类带子目录的产物塞不进单段参数
  // （会拆成两段 → 匹配不上 → 404）。`*` 只能作最后一段，值在 params['*']。
  host.http.route({
    method: 'GET',
    path: '/diagram/*',
    handler: (req: PluginRouteRequest) => {
      const file = req.params['*'];
      if (!file || !ALLOWED_FILES.has(file)) {
        return { status: 404, json: { error: 'unknown diagram', file: file ?? null } };
      }
      const abs = path.resolve(ASSETS_DIR, file);
      // 白名单已经挡住了穿越，这里再确认一次（白名单是代码，写错也不该变成任意文件读）。
      if (!abs.startsWith(path.resolve(ASSETS_DIR) + path.sep)) {
        return { status: 400, json: { error: 'bad path' } };
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return {
          status: 404,
          json: { error: 'diagram not generated yet', file, hint: '跑 archify finalize 生成 assets/' },
        };
      }
      return new Response(readFileSync(abs), {
        status: 200,
        headers: {
          'content-type': CONTENT_TYPE,
          // 产物随插件版本变化：no-cache 让重装/reload 后立刻生效，避免 iframe 拿旧的。
          'cache-control': 'no-cache',
        },
      });
    },
  });
}
