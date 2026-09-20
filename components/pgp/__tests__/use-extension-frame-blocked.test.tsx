import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { frameBlockedError, useExtensionFrameBlocked } from '../use-extension-frame-blocked';

/** jsdom has no CSP engine, so the event the browser would fire is built here. */
function violation(over: Partial<SecurityPolicyViolationEvent> = {}): Event {
  return Object.assign(new Event('securitypolicyviolation'), {
    effectiveDirective: 'frame-src',
    violatedDirective: 'frame-src',
    blockedURI: 'chrome-extension://kajibbejlbohfaggdiogboambcijhkke/editor.html',
    ...over,
  });
}

describe('useExtensionFrameBlocked', () => {
  it('reports a frame-src violation against an extension origin', () => {
    const onBlocked = vi.fn();
    renderHook(() => useExtensionFrameBlocked(true, onBlocked));
    document.dispatchEvent(violation());
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['moz-extension://1f9d.../editor.html', 'moz-extension'],
    ['safari-web-extension://abc/editor.html', 'safari-web-extension'],
  ])('recognizes %s', (blockedURI) => {
    const onBlocked = vi.fn();
    renderHook(() => useExtensionFrameBlocked(true, onBlocked));
    document.dispatchEvent(violation({ blockedURI }));
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('accepts the older full directive text, with no effectiveDirective', () => {
    const onBlocked = vi.fn();
    renderHook(() => useExtensionFrameBlocked(true, onBlocked));
    document.dispatchEvent(violation({ effectiveDirective: '', violatedDirective: "frame-src 'self' blob:" }));
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another directive', { effectiveDirective: 'script-src', violatedDirective: 'script-src' }],
    ['a frame from somewhere else', { blockedURI: 'https://tracker.example.com/f.html' }],
  ])('ignores %s', (_label, over) => {
    const onBlocked = vi.fn();
    renderHook(() => useExtensionFrameBlocked(true, onBlocked));
    document.dispatchEvent(violation(over));
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('listens only while active, and stops on unmount', () => {
    const onBlocked = vi.fn();
    const inactive = renderHook(() => useExtensionFrameBlocked(false, onBlocked));
    document.dispatchEvent(violation());
    expect(onBlocked).not.toHaveBeenCalled();
    inactive.unmount();

    const active = renderHook(() => useExtensionFrameBlocked(true, onBlocked));
    active.unmount();
    document.dispatchEvent(violation());
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('carries a code the composer can translate', () => {
    expect(frameBlockedError()).toMatchObject({ code: 'BULWARK_FRAME_BLOCKED' });
  });
});
