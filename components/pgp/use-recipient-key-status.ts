"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { checkRecipientKeys, uniqueAddresses, type RecipientKeyStatus } from '@/lib/mailvelope/recipients';
import type { MailvelopeKeyring } from '@/lib/mailvelope/types';

const DEBOUNCE_MS = 600;

interface RecipientKeyStatusResult {
  statuses: RecipientKeyStatus[];
  /** True while some recipient has no answer yet. */
  checking: boolean;
  /** Addresses whose lookup failed outright (extension error), as opposed to "no key". */
  failed: string[];
  /** Drop cached answers (all, or one address after an import) and ask again. */
  refresh: (address?: string) => void;
}

/**
 * Key status for the composer's recipients, while PGP is on. Mailvelope may
 * consult WKD and key servers for addresses it has no local key for, so answers
 * are debounced while the user types and cached per address for the session.
 * A failed lookup is not retried until `refresh`, so an unhappy extension
 * cannot turn this into a request loop.
 */
export function useRecipientKeyStatus(
  enabled: boolean,
  keyring: MailvelopeKeyring | null,
  recipients: string[],
): RecipientKeyStatusResult {
  const cacheRef = useRef(new Map<string, RecipientKeyStatus>());
  const failedRef = useRef(new Set<string>());
  // Bumped whenever the caches change, to re-render and re-run the effect.
  const [revision, setRevision] = useState(0);

  const addresses = uniqueAddresses(recipients);
  const addressKey = addresses.join('\n');

  useEffect(() => {
    if (!enabled || !keyring) return;
    const unresolved = addressKey
      .split('\n')
      .filter((address) => address && !cacheRef.current.has(address) && !failedRef.current.has(address));
    if (unresolved.length === 0) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const results = await checkRecipientKeys(keyring, unresolved);
        if (cancelled) return;
        for (const status of results) cacheRef.current.set(status.address, status);
      } catch {
        if (cancelled) return;
        for (const address of unresolved) failedRef.current.add(address);
      }
      setRevision((r) => r + 1);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, keyring, addressKey, revision]);

  const refresh = useCallback((address?: string) => {
    if (address) {
      cacheRef.current.delete(address.toLowerCase());
      failedRef.current.delete(address.toLowerCase());
    } else {
      cacheRef.current.clear();
      failedRef.current.clear();
    }
    setRevision((r) => r + 1);
  }, []);

  if (!enabled) return { statuses: [], checking: false, failed: [], refresh };

  const statuses = addresses.flatMap((address) => {
    const status = cacheRef.current.get(address);
    return status ? [status] : [];
  });
  const failed = addresses.filter((address) => failedRef.current.has(address));
  return { statuses, checking: statuses.length + failed.length < addresses.length, failed, refresh };
}
