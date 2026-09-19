"use client";

import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { encryptAndBuildMessage, pgpErrorMessageKey } from '@/lib/mailvelope/compose';
import type { MimeAddress } from '@/lib/mailvelope/pgp-mime';
import { importRecipientKey, type RecipientKeyStatus } from '@/lib/mailvelope/recipients';
import { sanitizeDisplayName } from '@/lib/rfc5322-mailbox';
import type { MailvelopeEditor } from '@/lib/mailvelope/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { SendEmailResult } from '@/lib/jmap/types';
import { useEmailStore } from '@/stores/email-store';
import { selectPgpAvailable, useMailvelopeStore, usePgpAvailable } from '@/stores/mailvelope-store';
import { toast } from '@/stores/toast-store';
import type { PgpComposeMode } from './pgp-compose-controls';
import { useRecipientKeyStatus } from './use-recipient-key-status';

export interface UsePgpComposeOptions {
  /** Every To/Cc/Bcc address, including text typed but not yet committed. */
  recipients: string[];
  /** Files already uploaded to the server in plain form. */
  hasAttachments: boolean;
  /** What has been typed so far, carried into the encrypted editor. */
  getPlainText: () => string;
  hasServerDraft: () => boolean;
  /** Remove the plaintext draft from the server and forget its id. Throws on failure. */
  discardServerDraft: () => Promise<void>;
  /** The typed text now lives in the encrypted editor: clear Bulwark's copy. */
  onEncryptionStarted: () => void;
}

export interface PgpSendParams {
  /** Client of the account the identity belongs to. */
  client: IJMAPClient;
  identityId: string;
  from: MimeAddress;
  to: MimeAddress[];
  cc: MimeAddress[];
  bcc: MimeAddress[];
  subject: string;
  inReplyTo?: string[];
  references?: string[];
  delayedUntil?: string;
}

type EditorStatus = 'starting' | 'ready' | 'error';

/**
 * Everything the composer needs for Mailvelope encryption, so email-composer.tsx
 * only wires it in. While PGP is on the composer must not persist anything the
 * user typed: `activeRef` is the flag `saveDraft` checks, and it flips before
 * the plaintext draft is deleted so no save can slip in between.
 */
export function usePgpCompose(options: UsePgpComposeOptions) {
  const t = useTranslations('pgp');
  const available = usePgpAvailable();
  const keyring = useMailvelopeStore((s) => s.keyring);
  const { dialogProps, confirm } = useConfirmDialog();

  const [mode, setMode] = useState<PgpComposeMode>('off');
  const [initialText, setInitialText] = useState('');
  const [editorStatus, setEditorStatus] = useState<EditorStatus>('starting');
  const editorRef = useRef<MailvelopeEditor | null>(null);
  const activeRef = useRef(false);

  // Stays on if the extension disconnects mid-compose (it updated or was disabled):
  // dropping to the normal composer would show an empty editor while the text
  // the user typed is gone with the extension's iframe.
  const active = mode !== 'off';
  const disconnected = active && !available;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const keyStatus = useRecipientKeyStatus(active, keyring, options.recipients);
  const missing = keyStatus.statuses.filter((s) => s.state === 'missing');

  const toggleEncrypt = useCallback(async () => {
    const opts = optionsRef.current;
    if (mode === 'off') {
      if (opts.hasAttachments) {
        toast.error(t('enable_blocked_attachments'));
        return;
      }
      if (opts.hasServerDraft()) {
        const ok = await confirm({
          title: t('enable_draft_title'),
          message: t('enable_draft_message'),
          confirmText: t('enable_confirm'),
          variant: 'destructive',
        });
        if (!ok) return;
      }
      const text = opts.getPlainText();
      // Block every save first, then remove what is already on the server.
      activeRef.current = true;
      try {
        await opts.discardServerDraft();
      } catch {
        activeRef.current = false;
        toast.error(t('enable_draft_failed'));
        return;
      }
      setInitialText(text);
      setEditorStatus('starting');
      opts.onEncryptionStarted();
      setMode('encrypt');
      return;
    }

    const ok = await confirm({
      title: t('disable_title'),
      message: t('disable_message'),
      confirmText: t('disable_confirm'),
      variant: 'destructive',
    });
    if (!ok) return;
    activeRef.current = false;
    editorRef.current = null;
    setInitialText('');
    setMode('off');
  }, [mode, confirm, t]);

  const toggleSign = useCallback(async () => {
    if (mode === 'off') return;
    const ok = await confirm({
      title: t('sign_switch_title'),
      message: t('sign_switch_message'),
      confirmText: t('sign_switch_confirm'),
      variant: 'destructive',
    });
    if (!ok) return;
    // The editor's options are fixed at creation, so it restarts empty.
    editorRef.current = null;
    setInitialText('');
    setEditorStatus('starting');
    setMode(mode === 'encrypt' ? 'encrypt-sign' : 'encrypt');
  }, [mode, confirm, t]);

  const onEditor = useCallback((editor: MailvelopeEditor | null) => {
    editorRef.current = editor;
    setEditorStatus(editor ? 'ready' : 'starting');
  }, []);

  const onEditorError = useCallback(
    (err: unknown) => {
      setEditorStatus('error');
      toast.error(t('editor_failed', { message: err instanceof Error ? err.message : String(err) }));
    },
    [t],
  );

  const manageKeys = useCallback(async () => {
    try {
      await useMailvelopeStore.getState().keyring?.openSettings();
    } catch {
      toast.error(t('error_generic'));
    }
  }, [t]);

  const importKey = useCallback(
    async (status: RecipientKeyStatus) => {
      const current = useMailvelopeStore.getState().keyring;
      if (!current) return;
      try {
        const result = await importRecipientKey(current, status);
        if (result === 'REJECTED') toast.info(t('import_rejected'));
        else if (result) toast.success(t('import_done'));
        keyStatus.refresh(status.address);
      } catch {
        toast.error(t('import_failed'));
      }
    },
    [keyStatus, t],
  );

  // Why Send is unavailable right now, or null. Recipients without a key block
  // it rather than falling back to plaintext: that choice is the user's.
  let sendBlockedReason: string | null = null;
  if (active) {
    if (disconnected) sendBlockedReason = t('error_disconnected');
    else if (editorStatus === 'error') sendBlockedReason = t('editor_failed_short');
    else if (editorStatus !== 'ready') sendBlockedReason = t('editor_not_ready');
    else if (keyStatus.checking) sendBlockedReason = t('recipients_checking');
    else if (missing.length > 0) {
      sendBlockedReason = t('send_blocked_missing', { addresses: missing.map((s) => s.address).join(', ') });
    } else if (keyStatus.failed.length > 0) sendBlockedReason = t('send_blocked_failed');
  }

  /**
   * Encrypt the editor content and submit the resulting PGP/MIME message.
   * The plaintext never leaves the extension; only ciphertext is uploaded.
   */
  const send = useCallback(
    async (params: PgpSendParams): Promise<SendEmailResult> => {
      const editor = editorRef.current;
      const currentKeyring = useMailvelopeStore.getState().keyring;
      const state = useMailvelopeStore.getState();
      if (!editor || !currentKeyring || !selectPgpAvailable(state)) throw new Error(t('editor_not_ready'));
      try {
        const { raw, envelopeRecipients } = await encryptAndBuildMessage({
          editor,
          keyring: currentKeyring,
          // Servers hand identity names back as `Name <addr>`; the header would then read `"Name <addr>" <addr>`.
          from: { name: sanitizeDisplayName(params.from.name) || undefined, email: params.from.email },
          to: params.to,
          cc: params.cc,
          bcc: params.bcc,
          subject: params.subject,
          inReplyTo: params.inReplyTo,
          references: params.references,
        });
        const blob = new Blob([raw], { type: 'message/rfc822' });
        return await useEmailStore
          .getState()
          .sendRawEmail(params.client, blob, params.identityId, params.delayedUntil, envelopeRecipients, { forceEnvelope: true, isPgp: true });
      } catch (err) {
        // Mailvelope errors carry a code; anything else (network, server) is shown as is.
        if ((err as { code?: string } | undefined)?.code) throw new Error(t(pgpErrorMessageKey(err)));
        throw err;
      }
    },
    [t],
  );

  const dialog: ReactNode = <ConfirmDialog {...dialogProps} />;

  return {
    available,
    mode,
    active,
    /** Read by `saveDraft`: true from the moment encryption starts until it is switched off. */
    activeRef,
    signing: mode === 'encrypt-sign',
    initialText,
    sendBlockedReason,
    toggleEncrypt,
    toggleSign,
    send,
    dialog,
    editorProps: { signMsg: mode === 'encrypt-sign', initialText, onEditor, onError: onEditorError },
    bannerProps: {
      signing: mode === 'encrypt-sign',
      disconnected,
      statuses: keyStatus.statuses,
      failed: keyStatus.failed,
      checking: keyStatus.checking,
      onImport: importKey,
      onRefresh: () => keyStatus.refresh(),
      onManageKeys: manageKeys,
    },
  };
}
