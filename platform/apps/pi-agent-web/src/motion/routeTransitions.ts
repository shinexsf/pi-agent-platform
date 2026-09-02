import { nextTick } from 'vue';
import type { RouteLocationNormalized, Router } from 'vue-router';

type RouteDirection = 'forward' | 'back' | 'lateral';

function routeDirection(to: RouteLocationNormalized, from: RouteLocationNormalized): RouteDirection {
  const sessionDetail = /^\/sessions\/[^/]+$/;
  if (from.path === '/sessions' && sessionDetail.test(to.path)) return 'forward';
  if (sessionDetail.test(from.path) && to.path === '/sessions') return 'back';
  return 'lateral';
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function installRouteTransitions(router: Router): void {
  let resolveRouteUpdate: (() => void) | null = null;
  let activeTransition: ViewTransition | null = null;

  function finishPendingUpdate(): void {
    resolveRouteUpdate?.();
    resolveRouteUpdate = null;
  }

  router.beforeEach((to, from) => {
    if (
      typeof document.startViewTransition !== 'function'
      || prefersReducedMotion()
      || document.hidden
      || from.matched.length === 0
    ) {
      return true;
    }

    activeTransition?.skipTransition();
    finishPendingUpdate();
    document.documentElement.dataset.routeDirection = routeDirection(to, from);

    const routeUpdate = new Promise<void>((resolve) => {
      resolveRouteUpdate = resolve;
    });
    const transition = document.startViewTransition(() => routeUpdate);
    activeTransition = transition;
    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        if (activeTransition === transition) {
          activeTransition = null;
          delete document.documentElement.dataset.routeDirection;
        }
      });

    return true;
  });

  router.afterEach(async () => {
    await nextTick();
    requestAnimationFrame(finishPendingUpdate);
  });

  router.onError(finishPendingUpdate);
}
