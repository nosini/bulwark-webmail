// Pure helpers for wire-check.mjs: does the message a server delivered still
// have the structure Bulwark submitted? No network, no app imports, so the
// vitest suite can drive it directly.

/** Header block and body of a raw message, split at the first blank line. Works on binary (latin1) strings. */
export function splitMessage(raw) {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { head: raw, body: "" };
  return { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

/** Unfolded `[name, value]` pairs, in order. */
export function parseHeaders(head) {
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1][1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

const collapse = (value) => value.replace(/\s+/g, " ").trim();

/**
 * Compare what was submitted (`sent`) with what arrived (`received`). A server
 * may legitimately prepend trace headers (Received, Return-Path, DKIM, ...) and
 * add a Date or Message-ID that was missing; it must not alter a header we set,
 * touch the body, or leak Bcc.
 *
 * @returns {{ ok: boolean, problems: string[], addedHeaders: string[] }}
 */
export function compareWire(sent, received) {
  const problems = [];
  const s = splitMessage(sent);
  const r = splitMessage(received);
  const sentHeaders = parseHeaders(s.head);
  const receivedHeaders = parseHeaders(r.head);

  if (s.body !== r.body) {
    let at = 0;
    while (at < s.body.length && at < r.body.length && s.body[at] === r.body[at]) at++;
    problems.push(
      `body was altered (sent ${s.body.length} bytes, received ${r.body.length}; first difference at offset ${at})`,
    );
  }

  const receivedSet = new Set(receivedHeaders.map(([n, v]) => `${n.toLowerCase()}:${collapse(v)}`));
  for (const [name, value] of sentHeaders) {
    if (!receivedSet.has(`${name.toLowerCase()}:${collapse(value)}`)) {
      problems.push(`header "${name}" was changed or dropped (sent: ${collapse(value)})`);
    }
  }

  const contentType = receivedHeaders.find(([n]) => n.toLowerCase() === "content-type")?.[1] ?? "";
  if (!/^multipart\/encrypted\b/i.test(contentType)) problems.push(`Content-Type is not multipart/encrypted: ${contentType || "(missing)"}`);
  if (!/protocol\s*=\s*"?application\/pgp-encrypted"?/i.test(contentType)) problems.push("Content-Type lost its protocol=\"application/pgp-encrypted\" parameter");

  if (receivedHeaders.some(([n]) => n.toLowerCase() === "bcc")) problems.push("a Bcc header reached the recipient");

  const sentNames = new Set(sentHeaders.map(([n]) => n.toLowerCase()));
  const addedHeaders = [...new Set(receivedHeaders.map(([n]) => n).filter((n) => !sentNames.has(n.toLowerCase())))];

  return { ok: problems.length === 0, problems, addedHeaders };
}
