import { handleRequest, type RequestHandlerDeps } from './transport';
import type { BridgeMessage, BridgeRequest } from './shared';

/**
 * Initialize the parent-side bridge for inline-mode apps.
 *
 * Listens for {type: 'dsgo:request'} messages on the same window, dispatches
 * via the shared transport, and replies with {type: 'dsgo:response'}.
 *
 * Same-window postMessage trick: window.postMessage fires a message event on
 * window itself with event.source === window. The source guard prevents the
 * bridge from re-dispatching its own response messages.
 */
export function startInlineParentBridge(deps: RequestHandlerDeps): void {
  window.addEventListener('message', async (event: MessageEvent) => {
    // Allow window (real browsers) or null (jsdom/sandboxed same-document contexts).
    // Cross-origin frames have a non-null, non-window source so they are still excluded.
    // The type === 'dsgo:request' check below is the primary loop-prevention guard.
    if (event.source !== null && event.source !== window) return;
    const msg = event.data as BridgeMessage | undefined;
    if (!msg || msg.type !== 'dsgo:request') return;
    const req = msg as BridgeRequest;
    const response = await handleRequest(req, deps);
    window.postMessage(response, '*');
  });
}
