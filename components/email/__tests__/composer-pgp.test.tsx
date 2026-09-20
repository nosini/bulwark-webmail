import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));

// Keeps each slot's extraProps reachable so a test can drive what a plugin
// would call — the real slots render plugin code that is not loaded here.
const slots = vi.hoisted(() => ({ extraProps: new Map<string, Record<string, unknown>>() }));

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: ({ name, extraProps }: { name?: string; extraProps?: Record<string, unknown> }) => {
    if (name && extraProps) slots.extraProps.set(name, extraProps);
    return null;
  },
}));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null,
    connectionLost: false,
    getClientForAccount: () => undefined,
    getAllConnectedClients: () => new Map(),
    syncIdentities: () => {},
    refreshIdentities: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = {
    identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me' }],
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    draftSaveEnabled: false,
    sendRawEmail: (...args: unknown[]) => mv.sendRawEmail(...args),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

const updateSetting = vi.fn();

vi.mock('@/stores/settings-store', () => {
  const state = {
    timeFormat: '24h',
    plainTextMode: false,
    subAddressDelimiter: '+',
    autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    emptySubjectWarningEnabled: true,
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: (...args: unknown[]) => updateSetting(...args),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSettingsStore: hook };
});

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useContactStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});


// ─── Mailvelope: the extension is stubbed, everything of ours runs for real ───

const mv = vi.hoisted(() => ({
  available: true as boolean,
  /** address -> has a usable key */
  hasKey: (_address: string): boolean => true,
  encrypt: vi.fn(),
  sendRawEmail: vi.fn(),
  validKeyForAddress: vi.fn(),
}));

vi.mock('@/stores/mailvelope-store', () => {
  const keyring = {
    identifier: 'k',
    validKeyForAddress: (...a: unknown[]) => mv.validKeyForAddress(...a),
    importPublicKey: vi.fn(),
    hasPrivateKey: vi.fn(),
    exportOwnPublicKey: vi.fn(),
    openSettings: vi.fn(),
  };
  const state = () => ({ status: 'ready', api: {}, keyring, version: '6.3.0', init: async () => {} });
  const hook = (sel?: (s: ReturnType<typeof state>) => unknown) => (typeof sel === 'function' ? sel(state()) : state());
  hook.getState = state;
  return {
    useMailvelopeStore: hook,
    usePgpAvailable: () => mv.available,
    selectPgpAvailable: () => mv.available,
  };
});

vi.mock('@/components/pgp/mailvelope-editor', () => ({
  MailvelopeEditor: ({ signMsg, initialText, onEditor }: { signMsg: boolean; initialText?: string; onEditor: (e: unknown) => void }) => {
    React.useEffect(() => {
      onEditor({ encrypt: (...a: unknown[]) => mv.encrypt(...a), createDraft: vi.fn() });
      return () => onEditor(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signMsg]);
    return React.createElement('div', { 'data-testid': 'pgp-editor', 'data-initial-text': initialText ?? '', 'data-sign': String(signMsg) });
  },
}));

// ─── Misc dependency mocks ────────────────────────────────────────────────────

vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {} },
}));

vi.mock('@/lib/plugin-storage', () => ({ fileStorage: { saveFile: async () => {}, getFile: async () => null, deleteFile: async () => {} } }));

const hooks = vi.hoisted(() => ({ onDraftChange: vi.fn(), onBeforeEmailSend: vi.fn(), onBeforeAttachmentUpload: vi.fn() }));

vi.mock('@/lib/plugin-hooks', () => ({
  isExternalAttachmentResult: () => false,
  emailHooks: {
    onBeforeAttachmentUpload: { intercept: (...args: unknown[]) => hooks.onBeforeAttachmentUpload(...args) },
    onBeforeBlobUpload: { transform: async (value: unknown) => value },
    onAfterAttachmentUpload: { emit: () => {} },
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: (...args: unknown[]) => hooks.onDraftChange(...args) },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: (...args: unknown[]) => hooks.onBeforeEmailSend(...args) },
    onComposeSend: { intercept: async () => true },
    onTransformOutgoingEmail: { transform: async (email: unknown) => email },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/signature-utils', () => ({
  appendPlainTextSignature: (body: string) => body,
  getPlainTextSignature: () => '',
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const ARMOR = ['-----BEGIN PGP MESSAGE-----', '', 'hQEMA1Vn7c1u8bVh', '=AbCd', '-----END PGP MESSAGE-----'].join('\n');

const DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Plans',
  body: '<p>Still typing</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const createDraft = vi.fn();
const deleteEmail = vi.fn();
const uploadBlob = vi.fn();

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;
const pgpToggle = () => screen.getByTestId('composer-pgp-toggle');

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  cleanup();
  hooks.onBeforeEmailSend.mockReset().mockResolvedValue(true);
  hooks.onBeforeAttachmentUpload.mockReset().mockResolvedValue(true);
  mv.available = true;
  mv.hasKey = () => true;
  mv.encrypt.mockReset().mockResolvedValue(ARMOR);
  mv.sendRawEmail.mockReset().mockResolvedValue({ scheduled: false });
  mv.validKeyForAddress.mockReset().mockImplementation(async (addresses: string[]) =>
    Object.fromEntries(
      addresses.map((a) => [
        a,
        mv.hasKey(a) ? { keys: [{ fingerprint: 'f'.repeat(40), lastModified: new Date(0), source: 'LOC' }] } : false,
      ]),
    ),
  );
  createDraft.mockReset().mockResolvedValue('server-draft');
  deleteEmail.mockReset().mockResolvedValue(undefined);
  uploadBlob.mockReset().mockResolvedValue({ blobId: 'blob-1' });
  useAuthStore.setState({
    client: { createDraft, deleteEmail, uploadBlob, hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
  });
});

async function enablePgp() {
  fireEvent.click(pgpToggle());
  await screen.findByTestId('composer-pgp-banner');
}

describe('PGP toggle visibility', () => {
  it('is offered when the host supports it and Mailvelope is available', () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    expect(pgpToggle()).toBeInTheDocument();
  });

  it('is hidden when the extension is absent: the composer is exactly as before', () => {
    mv.available = false;
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    expect(screen.queryByTestId('composer-pgp-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument();
  });

  it('is hidden for a host that has not opted in, so it can never send a blank plaintext message', () => {
    render(<EmailComposer initialData={DRAFT} />);
    expect(screen.queryByTestId('composer-pgp-toggle')).not.toBeInTheDocument();
  });
});

describe('turning PGP on', () => {
  it('swaps the Tiptap editor for the encrypted one and carries the typed text over', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    await enablePgp();

    expect(screen.queryByTestId('rich-text-editor')).not.toBeInTheDocument();
    const editor = screen.getByTestId('pgp-editor');
    expect(editor.dataset.initialText).toContain('Still typing');
    expect(editor.dataset.sign).toBe('false');
    expect(screen.getByText('banner_cleartext_notice')).toBeInTheDocument();
  });

  it('refuses while attachments are already uploaded, since those are plaintext on the server', async () => {
    render(
      <EmailComposer
        initialData={{ ...DRAFT, attachments: [{ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 10 }] }}
        pgpSupported
      />,
    );
    fireEvent.click(pgpToggle());
    await sleep(50);
    expect(screen.queryByTestId('composer-pgp-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument();
  });

  it('deletes an existing plaintext server draft, after asking', async () => {
    render(<EmailComposer initialData={{ ...DRAFT, draftId: 'draft-1' }} pgpSupported />);
    fireEvent.click(pgpToggle());

    const confirmButton = await screen.findByText('enable_confirm');
    expect(deleteEmail).not.toHaveBeenCalled();
    fireEvent.click(confirmButton);

    await screen.findByTestId('composer-pgp-banner');
    expect(deleteEmail).toHaveBeenCalledWith('draft-1');
  });

  it('leaves everything alone, draft included, when the user declines', async () => {
    render(<EmailComposer initialData={{ ...DRAFT, draftId: 'draft-1' }} pgpSupported />);
    fireEvent.click(pgpToggle());

    await screen.findByText('enable_draft_title');
    fireEvent.click(screen.getByText('cancel'));

    await sleep(50);
    expect(deleteEmail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('composer-pgp-banner')).not.toBeInTheDocument();
  });

  it('starts the editor signing when the user asks for encrypt-and-sign', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    await enablePgp();
    fireEvent.click(screen.getByTestId('composer-pgp-sign-toggle'));
    fireEvent.click(await screen.findByText('sign_switch_confirm'));
    await waitFor(() => expect(screen.getByTestId('pgp-editor').dataset.sign).toBe('true'));
  });
});

describe('nothing of an encrypted message reaches the server', () => {
  it('control: without PGP, editing autosaves a server draft (so the checks below can fail)', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    fireEvent.change(screen.getByDisplayValue('Plans'), { target: { value: 'Plans v2' } });
    await waitFor(() => expect(createDraft).toHaveBeenCalled(), { timeout: 4000 });
  });

  it('never autosaves a draft while PGP is on', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    await enablePgp();
    fireEvent.change(screen.getByDisplayValue('Plans'), { target: { value: 'Plans v2' } });
    await sleep(2600);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('never saves on page unload either', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    await enablePgp();
    window.dispatchEvent(new Event('beforeunload'));
    await sleep(50);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('closing discards instead of offering to save, and saves nothing', async () => {
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    render(<EmailComposer initialData={DRAFT} pgpSupported requestCloseRef={requestCloseRef} onClose={vi.fn()} />);
    await enablePgp();

    React.act(() => requestCloseRef.current!());
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('close_pgp_message')).toBeInTheDocument();
    expect(within(dialog).queryByText('save')).not.toBeInTheDocument();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('does not upload files from the composer: the paperclip is off', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    await enablePgp();
    expect(screen.getByTitle('pgp_attachments_blocked')).toBeDisabled();
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('refuses an attachment offered by a plugin', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    await enablePgp();

    // What a "attach from WebDAV" plugin does: upload to JMAP itself, then ask
    // the composer to attach the blob. In PGP mode the blob is already on the
    // server in cleartext and the send path drops `attachments` anyway.
    const onAttach = slots.extraProps.get('composer-attachment-source')?.onAttach as (u: unknown) => void;
    expect(onAttach).toBeTypeOf('function');
    React.act(() => onAttach({ name: 'secret.pdf', type: 'application/pdf', size: 12, blobId: 'blob-plugin' }));

    expect(screen.queryByText('secret.pdf')).not.toBeInTheDocument();
  });

  it('stops the debounced draft snapshot reaching plugin observers', async () => {
    render(<EmailComposer initialData={DRAFT} pgpSupported />);
    await enablePgp();
    hooks.onDraftChange.mockClear();

    // The body lives in the extension, but the recipients and subject are here
    // and would be handed out every couple of seconds.
    fireEvent.change(screen.getByPlaceholderText('subject_placeholder'), { target: { value: 'Quarterly numbers' } });
    await sleep(2100);

    expect(hooks.onDraftChange).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('hands the host a rawSend that submits only the PGP/MIME ciphertext, with blank plaintext fields', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
    await enablePgp();
    await waitFor(() => expect(sendButton()).not.toBeDisabled(), { timeout: 3000 });

    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    const data = onSend.mock.calls[0][0];
    expect(data.body).toBe('');
    expect(data.htmlBody).toBeUndefined();
    expect(data.attachments).toBeUndefined();
    expect(typeof data.rawSend).toBe('function');
    // Nothing has been encrypted or submitted until the host calls rawSend.
    expect(mv.sendRawEmail).not.toHaveBeenCalled();

    await data.rawSend();

    // Recipients plus the sender, whose (mock) key is in the keyring, so Sent stays readable.
    expect(mv.encrypt).toHaveBeenCalledWith(['bob@example.com', 'me@example.com']);
    expect(mv.sendRawEmail).toHaveBeenCalledTimes(1);
    const [, blob, identityId, delayedUntil, envelope, options] = mv.sendRawEmail.mock.calls[0];
    expect(identityId).toBe('id-me');
    expect(delayedUntil).toBeUndefined();
    expect(envelope).toEqual(['bob@example.com']);
    // isPgp keeps undo-send from deleting the only copy of the message.
    expect(options).toEqual({ forceEnvelope: true, isPgp: true });

    const raw = await readBlob(blob as Blob);
    expect(raw).toContain('Content-Type: multipart/encrypted');
    expect(raw).toContain('protocol="application/pgp-encrypted"');
    expect(raw).toContain(ARMOR.replace(/\n/g, '\r\n'));
    expect(raw).toContain('Subject: Plans');
    expect(createDraft).not.toHaveBeenCalled();
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('writes a clean From when the server returns the identity name as "Name <addr>"', async () => {
    useIdentityStore.setState({ identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me Myself <me@example.com>' }] } as never);
    try {
      const onSend = vi.fn();
      render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
      await enablePgp();
      await waitFor(() => expect(sendButton()).not.toBeDisabled(), { timeout: 3000 });
      fireEvent.click(sendButton());
      await waitFor(() => expect(onSend).toHaveBeenCalled());
      await onSend.mock.calls[0][0].rawSend();

      const raw = await readBlob(mv.sendRawEmail.mock.calls[0][1] as Blob);
      expect(raw).toContain('From: Me Myself <me@example.com>\r\n');
    } finally {
      useIdentityStore.setState({ identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me' }] } as never);
    }
  });

  it('keeps Bcc recipients in the envelope and out of the message', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT, bcc: 'hidden@example.net', showBcc: true }} pgpSupported onSend={onSend} />);
    await enablePgp();
    await waitFor(() => expect(sendButton()).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await onSend.mock.calls[0][0].rawSend();

    const [, blob, , , envelope] = mv.sendRawEmail.mock.calls[0];
    expect(envelope).toEqual(['bob@example.com', 'hidden@example.net']);
    expect(await readBlob(blob as Blob)).not.toContain('hidden@example.net');
    // Encrypted to the Bcc recipient too, so they can read it.
    expect(mv.encrypt.mock.calls[0][0]).toContain('hidden@example.net');
  });

  it('blocks Send while a recipient has no key, and says which one', async () => {
    mv.hasKey = (address) => address !== 'bob@example.com';
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
    await enablePgp();

    expect(await screen.findByText('recipient_missing', undefined, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(sendButton()).toBeDisabled());
    fireEvent.click(sendButton());
    await sleep(50);
    expect(onSend).not.toHaveBeenCalled();
    expect(mv.encrypt).not.toHaveBeenCalled();
  });

  it('never falls back to sending anything when encryption fails', async () => {
    mv.encrypt.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NO_KEY_FOR_RECIPIENT' }));
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
    await enablePgp();
    await waitFor(() => expect(sendButton()).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalled());

    await expect(onSend.mock.calls[0][0].rawSend()).rejects.toThrow('error_no_key_for_recipient');
    expect(mv.sendRawEmail).not.toHaveBeenCalled();
  });

  it('refuses to hand the host a message when the ciphertext is not armored', async () => {
    mv.encrypt.mockResolvedValue('the plaintext, unencrypted');
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
    await enablePgp();
    await waitFor(() => expect(sendButton()).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalled());

    await expect(onSend.mock.calls[0][0].rawSend()).rejects.toThrow(/armored PGP MESSAGE/);
    expect(mv.sendRawEmail).not.toHaveBeenCalled();
  });
});

describe('extension disconnect mid-compose', () => {
  it('stays in PGP mode with a warning and blocks Send, instead of showing an empty normal editor', async () => {
    const onSend = vi.fn();
    const view = render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
    await enablePgp();

    mv.available = false;
    view.rerender(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('error_disconnected');
    expect(screen.queryByTestId('rich-text-editor')).not.toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    // The user can still leave PGP mode.
    expect(pgpToggle()).toBeInTheDocument();
  });
});

describe('additional review reproductions', () => {
  it('preserves REQUIRETLS on the encrypted send', async () => {
    useAuthStore.setState({ client: { createDraft, deleteEmail, uploadBlob,
      hasDelayedSend: () => false, getMaxDelayedSend: () => 0,
      supportsSubmissionExtension: () => true } as never });
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
    await enablePgp();
    fireEvent.click(screen.getByTestId('composer-require-tls-toggle'));
    expect(screen.getByTestId('composer-require-tls-toggle')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(sendButton()).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const data = onSend.mock.calls[0][0];
    expect(data.requireTls).toBe(true);
    await data.rawSend();
    expect(mv.sendRawEmail.mock.calls[0][5]).toEqual({ forceEnvelope: true, isPgp: true, requireTls: true });
  });

  it('keeps PGP subject and Bcc out of plugin send hooks', async () => {
    hooks.onBeforeEmailSend.mockClear();
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT, subject: 'Confidential acquisition', bcc: 'hidden@example.net', showBcc: true }} pgpSupported onSend={onSend} />);
    await enablePgp();
    await waitFor(() => expect(sendButton()).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(hooks.onBeforeEmailSend).not.toHaveBeenCalled();
  });
});


describe('additional upload race reproduction', () => {
  it('blocks PGP while a plaintext upload awaits plugin approval', async () => {
    let release!: (allowed: boolean) => void;
    hooks.onBeforeAttachmentUpload.mockReturnValue(new Promise<boolean>(r => { release = r; }));
    const view = render(<EmailComposer initialData={DRAFT} pgpSupported onSend={vi.fn()} />);
    const input = view.container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['secret contents'], 'secret.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(hooks.onBeforeAttachmentUpload).toHaveBeenCalled());
    fireEvent.click(pgpToggle());
    expect(screen.queryByTestId('pgp-editor')).not.toBeInTheDocument();
    expect(uploadBlob).not.toHaveBeenCalled();
    await React.act(async () => release(true));
    await waitFor(() => expect(uploadBlob).toHaveBeenCalledTimes(1));
    expect(uploadBlob.mock.calls[0][0].name).toBe('secret.txt');
  });
});


describe('PGP guard lifecycle', () => {
  it('allows encryption after a pending upload is vetoed', async () => {
    let release!: (allowed: boolean) => void;
    hooks.onBeforeAttachmentUpload.mockReturnValue(new Promise<boolean>(resolve => { release = resolve; }));
    const view = render(<EmailComposer initialData={DRAFT} pgpSupported />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['secret'], 'secret.txt')] },
    });
    await waitFor(() => expect(hooks.onBeforeAttachmentUpload).toHaveBeenCalled());
    fireEvent.click(pgpToggle());
    expect(screen.queryByTestId('pgp-editor')).not.toBeInTheDocument();
    await React.act(async () => release(false));
    await enablePgp();
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('still lets a plugin veto an ordinary unencrypted send', async () => {
    hooks.onBeforeEmailSend.mockResolvedValue(false);
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} pgpSupported onSend={onSend} />);
    fireEvent.click(sendButton());
    await waitFor(() => expect(hooks.onBeforeEmailSend).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
  });
});
