// Secret redaction for text the board stores from a failed run (incident reports). Anything shaped
// like a secret becomes `[redacted N chars]`, N the length of what was removed. Redact the whole
// text first and cut it to size after, so a cap can never split a secret into an unrecognised piece.
const mark = s => `[redacted ${s.length} chars]`;

// Provider tokens: the whole match is the secret.
const TOKENS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, // PEM / OpenSSH / PGP, terminated or not
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,                    // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,                   // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,                 // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{20,}/g,                     // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,                // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                  // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g,                        // Google API key
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,  // Stripe
  /\bhf_[A-Za-z0-9]{30,}/g,                          // Hugging Face
  /\bnpm_[A-Za-z0-9]{36}\b/g,                        // npm
  /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/g,                // age
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

// Long base64-ish runs with upper, lower and digits (a key body whose BEGIN line was cut away).
// Lowercase hex (commit shas, hashes) never matches.
const BLOB = /[A-Za-z0-9+/]{60,}={0,2}/g;
const blobLike = s => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);

// `Authorization: Bearer x`, `Basic x`: keep the scheme, drop the credential.
const AUTH = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/g;
const credLike = v => /\d/.test(v) || v.length >= 20 || /[._~+/=-]/.test(v) || /[a-z][A-Z]/.test(v);
// password=x, "api_key": "x", SECRET_TOKEN: x, --token x ... keep the name, drop the value.
const ASSIGN = /((?:^|[^A-Za-z0-9])["']?[A-Za-z0-9_.-]*(?:passw(?:or)?d|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*(?:[:=]|\s(?=["']))\s*)(["']?)([^\s"'`,;&)}\]]{6,})/gi;
// scheme://user:password@host
const URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi;

function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const re of TOKENS) s = s.replace(re, m => mark(m));
  s = s.replace(AUTH, (m, scheme, sp, v) => (credLike(v) ? `${scheme}${sp}${mark(v)}` : m));
  s = s.replace(URL_CRED, (m, a, v, at) => `${a}${mark(v)}${at}`);
  s = s.replace(ASSIGN, (m, head, q, v) => {
    if (/^\d+$/.test(v) || /^\[redacted/.test(v) || /^(?:true|false|null|none|undefined|required|optional)$/i.test(v)) return m;
    if (/^\$\{?[A-Za-z_]/.test(v)) return m; // a variable reference, not a value
    return `${head}${q}${mark(v)}`;
  });
  s = s.replace(BLOB, m => (blobLike(m) ? mark(m) : m));
  return s;
}

module.exports = { redact };
