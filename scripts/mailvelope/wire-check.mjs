#!/usr/bin/env node
// Does your JMAP server transmit a PGP/MIME message byte-faithfully?
//
// Sends a multipart/encrypted message the way Bulwark's PGP compose does
// (Blob/upload, Email/import into Drafts, EmailSubmission/set with an explicit
// envelope and onSuccessUpdateEmail into Sent), then reads back what the
// server stored and, when you give it a second local account, what that
// account received, and checks that the RFC 3156 structure and the
// protocol="application/pgp-encrypted" parameter survived.
//
// The payload is a DUMMY armored block, not real ciphertext: nothing here needs
// Mailvelope or any key. It uses the real builder (lib/mailvelope/pgp-mime.ts),
// which Node runs directly (type stripping, Node >= 22.18).
//
//   node scripts/mailvelope/wire-check.mjs --server https://mail.example.com \
//        --user alice@example.com --password '...' \
//        --to bob@example.com --to-user bob@example.com --to-password '...'
//
// Without --to-user/--to-password it checks the stored Sent copy only and prints
// the Message-ID: send to Thunderbird or gpg yourself and inspect the raw
// message there (`gpg --list-packets` on the encrypted.asc part).
//
// Flags: --bcc <addr> (checks Bcc never reaches --to), --cleanup (delete the
// test messages afterwards), --dry-run (print the message, no network).
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { buildPgpMimeMessage } from "../../lib/mailvelope/pgp-mime.ts";
import { compareWire } from "./wire-compare.mjs";

const { values: args } = parseArgs({
  options: {
    server: { type: "string" },
    user: { type: "string" },
    password: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    "to-user": { type: "string" },
    "to-password": { type: "string" },
    bcc: { type: "string" },
    cleanup: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
const marker = `wire-check ${randomBytes(4).toString("hex")}`;

/** A well-formed armored block around random bytes. Not decryptable, and it does not need to be. */
function dummyArmor() {
  const b64 = randomBytes(300).toString("base64").replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN PGP MESSAGE-----\n\n${b64}\n=AbCd\n-----END PGP MESSAGE-----`;
}

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

function need(name) {
  if (!args[name]) fail(`--${name} is required (see the header of this file)`);
  return args[name];
}

async function connect(server, user, password) {
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const headers = { Authorization: auth };
  const res = await fetch(new URL("/.well-known/jmap", server), { headers });
  if (!res.ok) fail(`session request for ${user} failed: HTTP ${res.status}`);
  const session = await res.json();
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  const call = async (methodCalls) => {
    const r = await fetch(session.apiUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ using: USING, methodCalls }),
    });
    if (!r.ok) fail(`JMAP request failed: HTTP ${r.status} ${await r.text()}`);
    const json = await r.json();
    for (const [name, result] of json.methodResponses) {
      if (name === "error" || name.endsWith("/error")) fail(`${name}: ${JSON.stringify(result)}`);
    }
    return json.methodResponses;
  };
  const upload = async (bytes) => {
    const r = await fetch(session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId)), {
      method: "POST",
      headers: { ...headers, "Content-Type": "message/rfc822" },
      body: bytes,
    });
    if (!r.ok) fail(`Blob/upload failed: HTTP ${r.status}`);
    return (await r.json()).blobId;
  };
  /** Blob content as a binary (latin1) string, so byte-for-byte comparison is exact. */
  const download = async (blobId) => {
    const url = session.downloadUrl
      .replace("{accountId}", encodeURIComponent(accountId))
      .replace("{blobId}", encodeURIComponent(blobId))
      .replace("{name}", "message.eml")
      .replace("{type}", encodeURIComponent("message/rfc822"));
    const r = await fetch(url, { headers });
    if (!r.ok) fail(`blob download failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer()).toString("latin1");
  };
  return { accountId, call, upload, download };
}

async function mailboxByRole(jmap, role) {
  const [[, res]] = await jmap.call([["Mailbox/get", { accountId: jmap.accountId, properties: ["role"] }, "0"]]);
  const box = res.list.find((m) => m.role === role);
  if (!box) fail(`no ${role} mailbox on the account`);
  return box.id;
}

const fromEmail = args.from ?? args.user;
const toEmail = args.to ?? args["to-user"] ?? "recipient@example.com";
const bccEmail = args.bcc;

const { raw } = buildPgpMimeMessage({
  from: { email: fromEmail ?? "sender@example.com" },
  to: [{ email: toEmail }],
  subject: marker,
  armored: dummyArmor(),
});

if (args["dry-run"]) {
  console.log(raw);
  process.exit(0);
}

const server = need("server");
const sender = await connect(server, need("user"), need("password"));
const drafts = await mailboxByRole(sender, "drafts");
const sent = await mailboxByRole(sender, "sent");
const [[, identities]] = await sender.call([["Identity/get", { accountId: sender.accountId }, "0"]]);
const identity = identities.list.find((i) => i.email.toLowerCase() === fromEmail.toLowerCase()) ?? identities.list[0];
if (!identity) fail("the account has no identity to send from");

console.log(`Sending "${marker}" as ${identity.email} to ${toEmail}${bccEmail ? ` (Bcc ${bccEmail})` : ""} ...`);
const blobId = await sender.upload(new TextEncoder().encode(raw));
const rcptTo = [toEmail, ...(bccEmail ? [bccEmail] : [])].map((email) => ({ email }));
const responses = await sender.call([
  ["Email/import", { accountId: sender.accountId, emails: { imp: { blobId, mailboxIds: { [drafts]: true }, keywords: { $draft: true, $seen: true } } } }, "0"],
  ["EmailSubmission/set", {
    accountId: sender.accountId,
    create: { sub: { emailId: "#imp", identityId: identity.id, envelope: { mailFrom: { email: identity.email }, rcptTo } } },
    onSuccessUpdateEmail: { "#sub": { mailboxIds: { [sent]: true }, "keywords/$draft": null } },
  }, "1"],
]);
const imported = responses.find(([n]) => n === "Email/import")[1];
if (imported.notCreated?.imp) fail(`Email/import: ${JSON.stringify(imported.notCreated.imp)}`);
const submission = responses.find(([n]) => n === "EmailSubmission/set")[1];
if (submission.notCreated?.sub) fail(`EmailSubmission/set: ${JSON.stringify(submission.notCreated.sub)}`);
const emailId = imported.created.imp.id;

let failures = 0;
const report = (label, result) => {
  console.log(`\n${label}: ${result.ok ? "OK" : "PROBLEMS"}`);
  for (const p of result.problems) console.log(`  - ${p}`);
  if (result.addedHeaders.length) console.log(`  headers added by the server: ${result.addedHeaders.join(", ")}`);
  if (!result.ok) failures++;
};

// 1. What the server stored after Email/import.
const [[, got]] = await sender.call([["Email/get", { accountId: sender.accountId, ids: [emailId], properties: ["blobId"] }, "0"]]);
const storedRaw = await sender.download(got.list[0].blobId);
report("Stored copy (Email/import fidelity)", compareWire(raw, storedRaw));

// 2. What the recipient's mailbox received, when we can read it.
let receivedId;
let recipient;
if (args["to-user"] && args["to-password"]) {
  recipient = await connect(server, args["to-user"], args["to-password"]);
  let found;
  for (let i = 0; i < 20 && !found; i++) {
    const [[, q]] = await recipient.call([["Email/query", { accountId: recipient.accountId, filter: { subject: marker } }, "0"]]);
    found = q.ids[0];
    if (!found) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!found) fail("the message did not arrive within 30 s");
  receivedId = found;
  const [[, rg]] = await recipient.call([["Email/get", { accountId: recipient.accountId, ids: [found], properties: ["blobId"] }, "0"]]);
  const receivedRaw = await recipient.download(rg.list[0].blobId);
  const result = compareWire(raw, receivedRaw);
  if (bccEmail && receivedRaw.toLowerCase().includes(bccEmail.toLowerCase())) {
    result.problems.push(`the Bcc address ${bccEmail} appears in the delivered message`);
    result.ok = false;
  }
  report("Delivered copy (EmailSubmission/set + local delivery)", result);
} else {
  console.log("\nNo --to-user/--to-password: not checking delivery.");
  console.log(`Send to an external client and inspect the raw message there. Subject: ${marker}`);
}

if (args.cleanup) {
  await sender.call([["Email/set", { accountId: sender.accountId, destroy: [emailId] }, "0"]]);
  if (recipient && receivedId) await recipient.call([["Email/set", { accountId: recipient.accountId, destroy: [receivedId] }, "0"]]);
  console.log("\nTest messages deleted.");
}

if (failures > 0) {
  console.error("\nRESULT: the server does NOT preserve the PGP/MIME message. Do not ship PGP compose against it.");
  process.exit(1);
}
console.log("\nRESULT: structure and protocol parameter preserved.");
