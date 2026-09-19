"use client";

import { useEffect, useRef } from 'react';
import { useMailvelopeStore } from '@/stores/mailvelope-store';
import type { MailvelopeEditor as MailvelopeEditorHandle } from '@/lib/mailvelope/types';
import { createMailvelopeHost } from './mailvelope-host';

interface MailvelopeEditorProps {
  /** Sign in addition to encrypting. Fixed for the editor's lifetime: change it and the editor restarts. */
  signMsg: boolean;
  /** Text the editor starts with (a reply's quote, what was typed before encrypting). Read once. */
  initialText?: string;
  /** Called with the editor handle when ready, and with null when it goes away. */
  onEditor: (editor: MailvelopeEditorHandle | null) => void;
  onError: (error: unknown) => void;
}

/**
 * Mailvelope's editor container in place of the Tiptap composer. The user types
 * inside the extension's iframe, so Bulwark never holds the plaintext: it only
 * gets ciphertext back from `editor.encrypt()`.
 */
export function MailvelopeEditor({ signMsg, initialText, onEditor, onError }: MailvelopeEditorProps) {
  const api = useMailvelopeStore((s) => s.api);
  const keyring = useMailvelopeStore((s) => s.keyring);
  const containerRef = useRef<HTMLDivElement>(null);

  const initialTextRef = useRef(initialText);
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !api || !keyring) return;
    let cancelled = false;
    const host = createMailvelopeHost(container);

    api
      .createEditorContainer(host.selector, keyring, {
        signMsg,
        ...(initialTextRef.current ? { predefinedText: initialTextRef.current } : {}),
      })
      .then((editor) => {
        if (!cancelled) onEditorRef.current(editor);
      })
      .catch((err) => {
        if (!cancelled) onErrorRef.current(err);
      });

    return () => {
      cancelled = true;
      onEditorRef.current(null);
      host.dispose();
    };
  }, [api, keyring, signMsg]);

  return (
    <div
      ref={containerRef}
      className="w-full"
      style={{ height: 'calc(100vh - 380px)', minHeight: 300 }}
      data-testid="pgp-editor"
    />
  );
}
