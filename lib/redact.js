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

// `Authorization: <anything>`: the whole credential goes, whatever its case or shape.
// The scheme word is never taken for the credential, however short the credential is.
const AUTHZ = /(\bauthorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|digest)\s+)?)(?!(?:bearer|basic|token|digest)\b)([^\s"'`]+)/gi;
// `Bearer x`, `Basic x` elsewhere: keep the scheme, drop the credential, however short. `Bearer`
// spelt as the scheme (capital B) takes any value but an English word that follows it in prose
// ("Bearer token", "the Bearer of"); lowercase "bearer" and "Basic" need a credential-shaped value.
const AUTH = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]+)/gi;
const credLike = v => /\d/.test(v) || v.length >= 20 || /[._~+/=-]/.test(v) || /[a-z][A-Z]/.test(v);
const PROSE = /^(?:of|the|a|an|and|or|to|in|on|is|are|was|for|with|token|tokens|auth|authentication|authorization|header|headers|scheme|credentials?|value|string|format)$/i;
// password=x, "api_key": "x", SECRET_TOKEN: x, password="a pass phrase" ... keep the name, drop the
// value: a quoted value up to its closing quote, an unquoted one up to whitespace.
const ASSIGN = /((?:^|[^A-Za-z0-9])["']?([A-Za-z0-9_.-]*(?:passw(?:or)?d|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)["']?\s*(?:[:=]|\s(?=["']))\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/gi;
// Keys that hold counts, not secrets: input_tokens, max_tokens, token_count, tokens_in ...
const COUNT_KEY = /(?:tokens|count|max|limit|len|length|size|budget)(?:_[a-z]+)?$|tokens_|_tokens|^max_|^num_/i;
// scheme://user:password@host
const URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
const NOT_SECRET = /^(?:true|false|null|none|nil|undefined|required|optional|redacted|yes|no|\*+|x+)$/i;

function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const re of TOKENS) s = s.replace(re, m => mark(m));
  s = s.replace(AUTHZ, (m, head, v) => (/^\[redacted/.test(v) ? m : `${head}${mark(v)}`));
  s = s.replace(AUTH, (m, scheme, sp, v) => {
    if (/^\[redacted/.test(v) || PROSE.test(v)) return m;
    const asScheme = scheme === 'Bearer' || scheme === 'BEARER';
    return asScheme || credLike(v) ? `${scheme}${sp}${mark(v)}` : m;
  });
  s = s.replace(URL_CRED, (m, a, v, at) => (/^\[redacted/.test(v) ? m : `${a}${mark(v)}${at}`));
  s = s.replace(ASSIGN, (m, head, name, raw) => {
    const q = /^["']/.test(raw) ? raw[0] : '';
    // an unquoted value keeps the punctuation that ends it (`"input_tokens":1000,` or `x=abc;`)
    const tail = q ? '' : (raw.match(/[,;)}\]]+$/) || [''])[0];
    const v = q ? raw.slice(1, -1) : raw.slice(0, raw.length - tail.length);
    // however short: token=abc and password=123 are secrets too
    if (!v.length || NOT_SECRET.test(v) || /^\[redacted/.test(v)) return m;
    if (/^\d+$/.test(v) && COUNT_KEY.test(name)) return m; // a token count, not a token
    if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v) || /^\$\(/.test(v)) return m; // a variable reference, not a value
    return `${head}${q}${mark(v)}${q}${tail}`;
  });
  s = s.replace(BLOB, m => (blobLike(m) ? mark(m) : m));
  return s;
}

module.exports = { redact };
