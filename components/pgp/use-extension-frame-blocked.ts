"use client";

import { useEffect, useRef } from 'react';

/** Firefox randomizes its per-profile origin, so only the scheme is matched. */
const EXTENSION_SCHEME_RE = /^(?:chrome|moz|safari-web|ms-browser)-extension:/i;

/** Error raised for a blocked container, so the composer can explain it. */
export function frameBlockedError(): Error & { code: string } {
  return Object.assign(new Error('The page CSP blocks frames from the extension origin'), {
    code: 'BULWARK_FRAME_BLOCKED',
  });
}

/**
 * Calls `onBlocked` when this page's Content-Security-Policy refuses a frame
 * from a browser extension's origin.
 *
 * Nothing else reports it. `createEditorContainer` can still resolve, leaving
 * an editor that reports itself ready and is blank — one Send away from an
 * empty encrypted message — and a display container simply never paints. Both
 * look like a slow extension rather than a policy the operator has to change.
 */
export function useExtensionFrameBlocked(active: boolean, onBlocked: () => void): void {
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      // effectiveDirective is the modern field; older Chrome only sets
      // violatedDirective, and to the whole text ("frame-src 'self' blob:").
      const directive = event.effectiveDirective || event.violatedDirective || '';
      if (!directive.startsWith('frame-src') && !directive.startsWith('child-src')) return;
      if (!EXTENSION_SCHEME_RE.test(event.blockedURI || '')) return;
      onBlockedRef.current();
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => document.removeEventListener('securitypolicyviolation', onViolation);
  }, [active]);
}
