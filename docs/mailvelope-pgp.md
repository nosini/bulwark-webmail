# PGP with Mailvelope

Bulwark can read and send OpenPGP mail (PGP/MIME, RFC 3156, and inline PGP)
through the [Mailvelope](https://mailvelope.com) browser extension. It is
entirely client-side, so it works in the Lite static build as well as the full
build: no server component, no new endpoint, and no plugin.

All key handling stays inside the extension. Bulwark's JavaScript never sees a
private key, a passphrase, or the plaintext of an encrypted message: the user
types into, and reads from, iframes that the extension serves. The mail server
only ever receives the final ciphertext.

Nothing PGP-related is shown unless Mailvelope is present **and** this site is
authorized in it. Without that, Bulwark behaves exactly as it does without this
feature.

## Setup

1. Install Mailvelope (Chrome, Edge or Firefox).
2. In Mailvelope, open **Authorized Domains**, add the site the webmail is
   served from (pattern `[*.]host.name.tld[:port]`, for example
   `mail.example.com`) and switch on the entry's **API** option. Mailvelope
   only injects `window.mailvelope` into pages on that list. No meta tag or other
   opt-in is needed on the page.
3. Reload the webmail. **Settings > PGP encryption** appears. Generate or
   import your key there, and the composer gets an encrypt button.

If step 2 is missed, the extension is treated as absent: no error, no PGP UI.

### Content-Security-Policy

Mailvelope draws decrypted mail, its editor and its key manager in iframes from
the extension's own origin, so `frame-src` must allow the extension schemes:

```
frame-src 'self' blob: chrome-extension: moz-extension:
```

Firefox uses a random per-profile origin (`moz-extension://<uuid>`), so it can
not be pinned to one extension id; allow the scheme.

- **Netlify / Cloudflare Pages**: the `_headers` file Lite generates already
  contains this.
- **nginx / Caddy / a CDN** with their own policy: add the two schemes to your
  `frame-src`. A complete policy for a Lite build served from
  `mail.example.com`:

  ```nginx
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' https: data:; connect-src 'self' https://mail.example.com; frame-src 'self' blob: chrome-extension: moz-extension:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; media-src 'self' blob:" always;
  ```

  ```caddy
  header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' https: data:; connect-src 'self' https://mail.example.com; frame-src 'self' blob: chrome-extension: moz-extension:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; media-src 'self' blob:"
  ```

- **Stalwart Application** (`--target=stalwart`): Stalwart sends no CSP for an
  Application, so nothing is needed unless a reverse proxy in front adds one.
- **Full (Node) build**: `proxy.ts` builds the CSP and allows the two schemes
  itself, so nothing is needed unless a reverse proxy in front sets its own.

Without this the frames stay blank.

## Using it

**Reading.** An encrypted message opens decrypted in place of the normal body.
PGP/MIME (`multipart/encrypted`; the `encrypted.asc` part is fetched by blob
and handed to Mailvelope as armor) and inline PGP (an armored block in a
`text/plain` body, including cleartext-signed messages) are both recognized. The
signature status is shown by Mailvelope inside the message frame; the page does
not receive it. "Show original" switches back to the normal rendering.

**Writing.** The lock button in the composer toolbar turns on encryption. The
Tiptap editor is replaced by Mailvelope's editor, and a second button adds a
signature (encrypt and sign). The composer then:

- checks each recipient with `keyring.validKeyForAddress`, shows which have a key,
  offers to import a key found on WKD or a key server, and **blocks Send** while
  any recipient has none. It never falls back to sending unencrypted;
- encrypts to the sender too when their own key is in the keyring, so the copy in
  Sent stays readable;
- sends the message as PGP/MIME (below).

Encrypted mail has these differences from normal mail, and the composer says so:

- The **subject, sender, recipients and date are not encrypted.**
- **Nothing is saved to the server while encryption is on**: no autosave, no draft
  on close or unload. Closing discards the message. Turning encryption on for a
  message that already has a saved draft deletes that draft (after asking),
  because it holds the text in plain form.
- **Attachments** are added with the button inside the encrypted editor. The
  composer's own attach button is disabled: a file uploaded there would sit on the
  server unencrypted.
- **Bcc** recipients are encrypted to and put in the SMTP envelope, but no `Bcc:`
  header is written (unlike normal mail, the Sent copy does not record them).

## How sending works

`editor.encrypt(addresses)` returns an armored `PGP MESSAGE`. Mailvelope's editor
encrypts a MIME entity (`multipart/mixed` with the text and any attachments), which
is exactly the payload RFC 3156 asks for, so Bulwark wraps the armor:

```
Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary=...

--boundary
Content-Type: application/pgp-encrypted

Version: 1

--boundary
Content-Type: application/octet-stream; name="encrypted.asc"

-----BEGIN PGP MESSAGE----- ...
--boundary--
```

(`lib/mailvelope/pgp-mime.ts`.) It refuses to build anything unless the payload is
one complete armored `PGP MESSAGE`, so plaintext can not be wrapped and sent by
mistake.

The message goes out through the raw path, not `Email/set`, because a structured
`bodyStructure` can not express the `protocol=` parameter: `Blob/upload`, then
`Email/import` into Drafts, then `EmailSubmission/set` with an explicit envelope
and `onSuccessUpdateEmail` moving it to Sent (`JMAPClient.sendRawEmail`, shared with
S/MIME; the only addition is the opt-in `forceEnvelope`, since without it a Bcc-only
recipient would be dropped). Every JMAP request in this flow carries ciphertext
only.

### Check your server

Stalwart reads the imported blob unchanged and only prepends trace headers (and
optionally a DKIM signature), so the structure survives. That was established by
reading Stalwart's source, not by watching it on the wire. Confirm it on your own
server:

```sh
node scripts/mailvelope/wire-check.mjs --server https://mail.example.com \
  --user alice@example.com --password '...' \
  --to bob@example.com --to-user bob@example.com --to-password '...' --cleanup
```

It sends a PGP/MIME message with a dummy payload (no key or Mailvelope needed)
through the same calls, reads back the stored and the delivered copy, and fails if
the body, a header we set, or the `protocol` parameter changed, or if a `Bcc`
leaked. Without the `--to-user` options it checks the stored copy and prints the
subject so you can inspect the message in Thunderbird or with `gpg`. Anything that
rewrites the message in flight (a milter, an MTA hook, a Sieve `Replace`) shows up
there.

Stalwart's encryption at rest does not re-wrap a `multipart/encrypted` message.

## Differences from the original plan

Where the Mailvelope API (v6.3, read from `src/client-API/client-api.js`) differs
from what the design assumed:

- **No sign-only.** The editor offers `encrypt()` (with `signMsg` for
  encrypt-and-sign) and `createDraft()`. There is no way to sign without
  encrypting, so that is not offered.
- **Signature status is not returned to the page.** `createDisplayContainer`
  returns only an `error`; the extension shows the verification result inside its
  frame.
- **`editor.encrypt()` takes email addresses**, not keys. Mailvelope resolves (and
  may look up) the keys itself; `validKeyForAddress` is used up front to tell the
  user what will happen.
- **`createSettingsContainer` is deprecated** since Mailvelope 6.1 in favor of
  `keyring.openSettings()` (a new tab). The settings page embeds the container when
  present and always offers the button.
- **Signing is fixed when the editor starts.** Switching between encrypt and
  encrypt-and-sign restarts the editor and discards what was typed in it (after
  confirming).

## Known limits

- Checking a recipient's key can make Mailvelope look the address up on WKD or a
  key server (per its own settings). Those requests come from the extension, not
  from Bulwark, and Bulwark caches the answers for the session so typing in the
  recipient field does not repeat them.
- Replying to or forwarding an encrypted message quotes the still-encrypted text:
  the page can not read the plaintext to quote it. Type the quote into the editor.
- PGP/MIME messages that are only signed (`multipart/signed`) are not verified;
  the display container takes armored messages.
- If the extension updates while composing, its containers stop working. The
  composer stays in encrypted mode with a warning and blocks Send; reload the page.
  What was typed in the editor is lost.
- Extension automation is not available in CI, so the Mailvelope calls are
  exercised against a stub (`components/email/__tests__/composer-pgp.test.tsx`,
  `components/pgp/__tests__/`, `lib/__tests__/mailvelope-*.test.ts`). Try the real
  extension, and a round trip to an external client, before relying on it.

## Manual checks with the real extension

1. Generate a key in Settings > PGP encryption; import a friend's public key.
2. Compose to that friend: the banner shows their key as found; Send is enabled.
   Send to Thunderbird or `gpg` and confirm it decrypts and verifies (signed).
3. Compose to an address with no key: Send is blocked and names it.
4. Receive a PGP/MIME message and an inline-PGP message: both render decrypted.
5. With encryption on, watch the network tab: no `Email/set` draft, no upload, only
   the final `Blob/upload` of the ciphertext.
6. Disable the extension (or remove the domain): reload and confirm no PGP UI and no
   console errors.
