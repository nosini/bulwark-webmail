import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Mailbox, ScheduledEmail } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// "Cancel and edit" on a scheduled PGP message used to restore it to Drafts and
// hand it to the composer. The composer cannot read ciphertext, so it opened
// with the recipients and subject but an empty body -- one Send away from
// mailing an empty plaintext message to those recipients. PGP is now treated
// like S/MIME at the UI level (compose again), while the ciphertext is kept.

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

function makeScheduled(overrides: Partial<ScheduledEmail> = {}): ScheduledEmail {
  return {
    id: 'email-1',
    threadId: 'thread-1',
    emailSubmissionId: 'sub-1',
    scheduledIdentityId: 'identity-1',
    scheduledSendAt: new Date(Date.now() + 60_000).toISOString(),
    scheduledUndoStatus: 'pending',
    isScheduled: true,
    isSmimeScheduled: false,
    ...overrides,
  } as unknown as ScheduledEmail;
}

function makeClient(): IJMAPClient {
  return {
    getMailboxes: vi.fn().mockResolvedValue(MAILBOXES),
    getScheduledEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0, totalByAccount: {}, nextPosition: 0 }),
    cancelEmailSubmission: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    restoreEmailToDraft: vi.fn().mockResolvedValue(undefined),
    getEmail: vi.fn().mockResolvedValue({ id: 'email-1' }),
  } as unknown as IJMAPClient;
}

describe('cancelScheduledEmailForEdit', () => {
  beforeEach(() => {
    useEmailStore.setState({ mailboxes: MAILBOXES, pendingUndoSend: null, selectedEmailIds: new Set() });
    vi.clearAllMocks();
  });

  it('keeps a scheduled PGP message but never hands it to the composer', async () => {
    const client = makeClient();
    const restored = await useEmailStore
      .getState()
      .cancelScheduledEmailForEdit(client, makeScheduled({ isPgpScheduled: true }));

    expect(client.cancelEmailSubmission).toHaveBeenCalledWith('sub-1', undefined);
    expect(client.deleteEmail).not.toHaveBeenCalled();
    expect(client.restoreEmailToDraft).toHaveBeenCalledWith('email-1', 'drafts-1', 'sent-1');
    expect(restored).toBeNull();
  });

  it('still deletes a scheduled S/MIME message', async () => {
    const client = makeClient();
    const restored = await useEmailStore
      .getState()
      .cancelScheduledEmailForEdit(client, makeScheduled({ isSmimeScheduled: true }));

    expect(client.deleteEmail).toHaveBeenCalledWith('email-1');
    expect(client.restoreEmailToDraft).not.toHaveBeenCalled();
    expect(restored).toBeNull();
  });

  it('still returns a plain scheduled message for editing', async () => {
    const client = makeClient();
    const restored = await useEmailStore
      .getState()
      .cancelScheduledEmailForEdit(client, makeScheduled());

    expect(client.deleteEmail).not.toHaveBeenCalled();
    expect(client.restoreEmailToDraft).toHaveBeenCalledWith('email-1', 'drafts-1', 'sent-1');
    expect(restored).toEqual({ id: 'email-1' });
  });
});
