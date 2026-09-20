"use client";

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldCheck } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { extractEncryptedPayload, type PgpMessageSource } from '@/lib/mailvelope/detect';
import { useMailvelopeStore } from '@/stores/mailvelope-store';
import type { MailvelopeError } from '@/lib/mailvelope/types';
import { createMailvelopeHost } from './mailvelope-host';
import { useExtensionFrameBlocked } from './use-extension-frame-blocked';

interface MailvelopeDisplayProps {
  source: PgpMessageSource;
  /** Address of the sender: Mailvelope uses it to pick the key that verifies the signature. */
  senderAddress?: string;
  /** Fetches a blob of the message (PGP/MIME payload) as bytes. */
  fetchBlob: (blobId: string, name?: string, type?: string) => Promise<ArrayBuffer>;
  /** The user (or a failure) wants the regular rendering of this message instead. */
  onShowOriginal: () => void;
}

type Phase = 'loading' | 'ready' | 'failed';

/** Codes after which the regular rendering is more useful than an empty frame. */
const UNREADABLE_CODES = new Set(['ARMOR_PARSE_ERROR', 'WRONG_ARMORED_TYPE']);

/**
 * Shows a PGP message decrypted by Mailvelope in place of the normal body.
 * The plaintext lives only inside the extension's sandboxed iframe: it never
 * passes through Bulwark's JavaScript, and neither does the signature result,
 * which the extension renders inside the frame itself.
 */
export function MailvelopeDisplay({ source, senderAddress, fetchBlob, onShowOriginal }: MailvelopeDisplayProps) {
  const t = useTranslations('pgp');
  const api = useMailvelopeStore((s) => s.api);
  const keyring = useMailvelopeStore((s) => s.keyring);
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('loading');

  // Read through a ref so a new closure identity from the parent cannot restart decryption.
  const fetchBlobRef = useRef(fetchBlob);
  fetchBlobRef.current = fetchBlob;
  const onShowOriginalRef = useRef(onShowOriginal);
  onShowOriginalRef.current = onShowOriginal;

  // A blocked frame never loads and never errors: without this the spinner
  // would run for as long as the message stayed open.
  useExtensionFrameBlocked(phase === 'loading', () => setPhase('failed'));

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !api || !keyring) return;
    let cancelled = false;
    setPhase('loading');
    const host = createMailvelopeHost(container);

    (async () => {
      try {
        let armored: string | null;
        if (source.kind === 'inline') {
          armored = source.armored;
        } else {
          const bytes = await fetchBlobRef.current(source.payloadBlobId, source.payloadName, source.payloadType);
          armored = extractEncryptedPayload(new TextDecoder().decode(bytes));
        }
        if (cancelled) return;
        if (!armored) {
          setPhase('failed');
          return;
        }
        const display = await api.createDisplayContainer(host.selector, armored, keyring, { senderAddress });
        if (cancelled) return;
        const code = (display?.error as MailvelopeError | undefined)?.code;
        if (code && UNREADABLE_CODES.has(code)) {
          setPhase('failed');
          return;
        }
        // Other errors (no matching private key, cancelled passphrase prompt)
        // are explained by Mailvelope inside its own frame.
        setPhase('ready');
      } catch {
        if (!cancelled) setPhase('failed');
      }
    })();

    return () => {
      cancelled = true;
      host.dispose();
    };
  }, [api, keyring, source, senderAddress]);

  return (
    <div className="px-4 py-3 space-y-2" data-testid="pgp-display">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {phase === 'loading' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="w-3.5 h-3.5" />
          )}
          {phase === 'loading' ? t('display_loading') : phase === 'failed' ? t('display_failed') : t('display_note')}
        </span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onShowOriginalRef.current()}>
          {t('display_show_original')}
        </Button>
      </div>
      <div
        ref={containerRef}
        hidden={phase === 'failed'}
        className="w-full resize-y overflow-hidden rounded-md border border-border bg-background"
        style={{ height: 'min(70vh, 720px)', minHeight: 240 }}
      />
    </div>
  );
}
