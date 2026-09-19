import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Mailbox, SendEmailResult } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Undoing a PGP send used to delete the message. The plaintext only ever exists
// inside the Mailvelope editor, which is unmounted by the time the undo toast is
// clicked, so deleting the ciphertext destroyed the only copy. S/MIME keeps its
// existing delete behaviour, where the composer still holds the plaintext.

function makeMailbox(id: string, role: string): Mailbox {
  return {
    id,
    name: id,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    isShared: false,
  } as unknown as Mailbox;
}

const MAILBOXES = [makeMailbox('drafts-1', 'drafts'), makeMailbox('sent-1', 'sent')];

function makeClient(overrides: Partial<IJMAPClient> = {}): IJMAPClient {
  return {
    getMailboxes: vi.fn().mockResolvedValue(MAILBOXES),
    sendRawEmail: vi.fn().mockResolvedValue({
      scheduled: true,
      emailId: 'email-1',
      emailSubmissionId: 'sub-1',
      sendAt: new Date(Date.now() + 10_000).toISOString(),
    } satisfies SendEmailResult),
    cancelEmailSubmission: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    restoreEmailToDraft: vi.fn().mockResolvedValue(undefined),
    getEmail: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as IJMAPClient;
}

describe('undo-send for raw messages', () => {
  beforeEach(() => {
    useEmailStore.setState({ mailboxes: [], pendingUndoSend: null, selectedEmailIds: new Set() });
    vi.clearAllMocks();
  });

  it('records isPgp on the pending undo when the raw send is PGP/MIME', async () => {
    const client = makeClient();
    await useEmailStore.getState().sendRawEmail(
      client, new Blob(['raw']), 'identity-1', new Date(Date.now() + 10_000).toISOString(), ['b@example.org'],
      { forceEnvelope: true, isPgp: true },
    );
    expect(useEmailStore.getState().pendingUndoSend).toMatchObject({ isSmime: true, isPgp: true });
  });

  it('keeps the encrypted message in Drafts instead of deleting it', async () => {
    const client = makeClient();
    const restored = await useEmailStore.getState().cancelUndoSend(client, {
      submissionId: 'sub-1',
      emailId: 'email-1',
      identityId: 'identity-1',
      sendAt: new Date().toISOString(),
      isSmime: true,
      isPgp: true,
    });

    expect(client.cancelEmailSubmission).toHaveBeenCalledWith('sub-1', undefined);
    expect(client.deleteEmail).not.toHaveBeenCalled();
    expect(client.restoreEmailToDraft).toHaveBeenCalledWith('email-1', 'drafts-1', 'sent-1');
    // The composer cannot reopen ciphertext, so nothing is handed back to it.
    expect(restored).toBeNull();
    expect(useEmailStore.getState().pendingUndoSend).toBeNull();
  });

  it('still deletes an S/MIME message on undo', async () => {
    const client = makeClient();
    await useEmailStore.getState().cancelUndoSend(client, {
      submissionId: 'sub-1',
      emailId: 'email-1',
      identityId: 'identity-1',
      sendAt: new Date().toISOString(),
      isSmime: true,
    });

    expect(client.deleteEmail).toHaveBeenCalledWith('email-1');
    expect(client.restoreEmailToDraft).not.toHaveBeenCalled();
  });

  it('still restores a plain message to a draft on undo', async () => {
    const client = makeClient({ getEmail: vi.fn().mockResolvedValue({ id: 'email-1' }) });
    const restored = await useEmailStore.getState().cancelUndoSend(client, {
      submissionId: 'sub-1',
      emailId: 'email-1',
      identityId: 'identity-1',
      sendAt: new Date().toISOString(),
      isSmime: false,
    });

    expect(client.deleteEmail).not.toHaveBeenCalled();
    expect(client.restoreEmailToDraft).toHaveBeenCalledWith('email-1', 'drafts-1', 'sent-1');
    expect(restored).toEqual({ id: 'email-1' });
  });
});
