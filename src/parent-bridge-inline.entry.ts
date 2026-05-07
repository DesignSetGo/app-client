import { startInlineParentBridge } from './parent-bridge-inline';
import type { RequestHandlerDeps } from './transport';

declare global {
  interface Window {
    __dsgoBridgeDeps?: RequestHandlerDeps;
  }
}

if (window.__dsgoBridgeDeps) {
  startInlineParentBridge(window.__dsgoBridgeDeps);
}
