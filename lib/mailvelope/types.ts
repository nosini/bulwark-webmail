/**
 * The slice of the Mailvelope Client API (v6.x) that Bulwark uses.
 *
 * Mirrors src/client-API/client-api.js in github.com/mailvelope/mailvelope,
 * which is the authoritative definition (there is no published .d.ts). Every
 * key and crypto operation runs inside the extension; these are only the
 * page-side handles.
 */

export type MailvelopeErrorCode =
  | 'NO_KEYRING_FOR_ID'
  | 'KEYRING_ALREADY_EXISTS'
  | 'NO_KEY_FOR_RECIPIENT'
  | 'NO_KEY_FOR_ENCRYPTION'
  | 'NO_DEFAULT_KEY_FOUND'
  | 'ENCRYPT_IN_PROGRESS'
  | 'ENCRYPT_QUOTA_SIZE'
  | 'EDITOR_DIALOG_CANCEL'
  | 'PWD_DIALOG_CANCEL'
  | 'DECRYPT_ERROR'
  | 'ARMOR_PARSE_ERROR'
  | 'NO_KEY_FOUND'
  | 'IMPORT_ERROR'
  | 'WRONG_ARMORED_TYPE'
  | 'INVALID_OPTIONS'
  | 'TYPE_MISMATCH'
  | 'NO_CONNECTION';

export interface MailvelopeError extends Error {
  code?: MailvelopeErrorCode | string;
}

/** Where a key was found: local keyring, WKD, Mailvelope key server, keys.openpgp.org, Autocrypt. */
export type MailvelopeKeySource = 'LOC' | 'WKD' | 'MKS' | 'OKS' | 'AC';

export interface MailvelopeLookupResult {
  fingerprint: string;
  lastModified: Date;
  source: MailvelopeKeySource | string;
  lastSeen?: Date;
  /** Armored public key that can be imported. Not set for local keys. */
  armored?: string;
}

/** `false`: no valid key for the address. Otherwise the candidate keys. */
export type MailvelopeKeyMap = Record<string, false | { keys: MailvelopeLookupResult[] }>;

export type MailvelopeImportResult = 'IMPORTED' | 'UPDATED' | 'INVALIDATED' | 'REJECTED';

export interface MailvelopeKeyring {
  identifier: string;
  validKeyForAddress(recipients: string[]): Promise<MailvelopeKeyMap>;
  /** Prompts the user inside Mailvelope before importing. */
  importPublicKey(armored: string): Promise<MailvelopeImportResult>;
  hasPrivateKey(query?: string | { fingerprint?: string; email?: string }): Promise<boolean>;
  exportOwnPublicKey(emailAddr: string): Promise<string>;
  /** Opens the extension settings in a new browser tab. */
  openSettings(options?: { showDefaultKey?: boolean }): Promise<void>;
}

export interface MailvelopeEditor {
  /**
   * Encrypts the editor content for the given addresses (Mailvelope resolves
   * the keys itself) and returns an armored `-----BEGIN PGP MESSAGE-----`
   * block. The plaintext inside is a MIME entity, so it is a valid RFC 3156
   * payload as is. If the editor was created with `signMsg` it is signed too.
   */
  encrypt(recipients: string[]): Promise<string>;
  createDraft(): Promise<string>;
}

export interface MailvelopeDisplayContainer {
  error?: MailvelopeError;
}

export interface MailvelopeDisplayOptions {
  /** Address of the sender, used to pick the key for signature verification. */
  senderAddress?: string;
}

export interface MailvelopeEditorOptions {
  /** Content limit in kilobytes (Mailvelope default: 20480). */
  quota?: number;
  /** Sign the message in addition to encrypting it. Fixed for the editor's lifetime. */
  signMsg?: boolean;
  predefinedText?: string;
  quotedMail?: string;
  quotedMailIndent?: boolean;
  quotedMailHeader?: string;
  armoredDraft?: string;
  keepAttachments?: boolean;
}

export interface MailvelopeSettingsOptions {
  email?: string;
  fullName?: string;
}

export interface MailvelopeApi {
  getVersion(): Promise<string>;
  getKeyring(identifier: string): Promise<MailvelopeKeyring>;
  createKeyring(identifier: string): Promise<MailvelopeKeyring>;
  createDisplayContainer(
    selector: string,
    armored: string,
    keyring?: MailvelopeKeyring,
    options?: MailvelopeDisplayOptions,
  ): Promise<MailvelopeDisplayContainer>;
  createEditorContainer(
    selector: string,
    keyring?: MailvelopeKeyring,
    options?: MailvelopeEditorOptions,
  ): Promise<MailvelopeEditor>;
  /** Deprecated since Mailvelope 6.1.0 (use `keyring.openSettings()`); still present in 6.x. */
  createSettingsContainer?(
    selector: string,
    keyring?: MailvelopeKeyring,
    options?: MailvelopeSettingsOptions,
  ): Promise<undefined>;
}

declare global {
  interface Window {
    /** Injected by the Mailvelope extension on origins the user authorized. */
    mailvelope?: MailvelopeApi;
  }
}
