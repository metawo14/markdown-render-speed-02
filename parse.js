// parse.js — a fast, dependency-free CommonMark + GFM renderer whose output
// matches marked 18.1.3 (default options) byte for byte. Written from the
// CommonMark 0.31.2 / GFM 0.29 specs and black-box probing of marked's output;
// it does not import, copy or vendor marked.
//
// Layout: small helpers, inline parser (atoms + delimiter
// stack + link formation), block parser (line based, strip-and-recurse),
// parse() entry point.

// ---- character helpers ----
const SP = ' ';
function isSpace(c) {
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r') return true;
  const cp = c.charCodeAt(0);
  return cp === 0xA0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) ||
    cp === 0x202F || cp === 0x205F || cp === 0x3000;
}
function isPunct(c) {
  return (c >= '!' && c <= '/') || (c >= ':' && c <= '@') ||
    (c >= '[' && c <= '`') || (c >= '{' && c <= '~');
}
// Punctuation for emphasis flanking (marked's rule): Unicode punctuation
// (P) and symbols (S) count, but '~' does NOT (it is the strikethrough
// delimiter). '$' IS punctuation (Sc) — ' *$*alpha.' forms no emphasis.
function isFlankPunct(c) {
  if (c === '~') return false;
  return /[\p{P}\p{S}]/u.test(c);
}
// For '_' delimiters only, '~' DOES count as punctuation: '_b_~' closes
// and '~_a_' opens, while '*~*a' still forms (the '*' after '~' closes
// because '~' is not punctuation for '*').
function isFlankPunctU(c) {
  return /[\p{P}\p{S}]/u.test(c);
}
function isAlnum(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') || c.charCodeAt(0) > 127;
}
function isDigit(c) { return c >= '0' && c <= '9'; }
function isHex(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

// Escape text for HTML: & < > " '
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) {
  return s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
    s.indexOf('"') < 0 && s.indexOf("'") < 0 ? s : s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

// href: percent-encode like encodeURI, then escape for the attribute.
// Valid entity references in the destination pass through verbatim.
function encodeHref(s) {
  let e;
  // encodeURI percent-encodes '%' itself, but marked never encodes '%':
  // put every '%25' back to '%' (the only source of '%25' is a literal
  // '%', so this restores exactly what the author wrote).
  try { e = encodeURI(s).replace(/%25/g, '%'); } catch (_) { e = s; }
  return escEnt(e);
}

// End index (just past ';') of a valid entity reference starting at s[i]
// ('&name;' / '&#1-7 digits;' / '&#x1-6 hex;'), or -1. Named references
// are output verbatim by marked whether or not the name is defined.
function entityRefEnd(s, i) {
  const n = s.length;
  if (s[i] !== '&' || i + 1 >= n) return -1;
  if (s[i + 1] === '#') {
    let j = i + 2;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const start = j;
      while (j < n && isHex(s[j])) j++;
      if (j - start < 1 || j - start > 6) return -1;
    } else {
      const start = j;
      while (j < n && isDigit(s[j])) j++;
      if (j - start < 1 || j - start > 7) return -1;
    }
    if (j >= n || s[j] !== ';') return -1;
    return j + 1;
  }
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === ';') return j === i + 1 ? -1 : j + 1;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_')) return -1;
    j++;
  }
  return -1;
}

// Escape for attribute values (href/title/alt): valid entity references
// pass through verbatim; any other & and < > " ' are escaped.
function escEnt(s) {
  if (s.indexOf('&') < 0) return esc(s);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const e = entityRefEnd(s, i);
      if (e > 0) { out += s.slice(i, e); i = e; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '"') { out += '&quot;'; i++; continue; }
    if (c === "'") { out += '&#39;'; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Decode one entity starting at s[i] === '&'. Returns ['name', raw, end]
// for a named reference (output verbatim) or ['num', char, end] for a
// numeric reference (decoded; 0 / surrogate / >0x10FFFF become U+FFFD),
// or null when s[i..] is not a valid entity reference.
function decodeEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s[i + 1] === '#') {
    let j = i + 2;
    let cp = 0;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const start = j;
      while (j < n && isHex(s[j]) && j - start < 6) { cp = cp * 16 + parseInt(s[j], 16); j++; }
      if (j - start < 1 || j - start > 6) return null;
      if (j < n && isHex(s[j])) return null;
    } else {
      const start = j;
      while (j < n && isDigit(s[j]) && j - start < 7) { cp = cp * 10 + (s.charCodeAt(j) - 48); j++; }
      if (j - start < 1 || j - start > 7) return null;
      if (j < n && isDigit(s[j])) return null;
    }
    if (j >= n || s[j] !== ';') return null;
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return ['num', String.fromCodePoint(cp), j + 1];
  }
  const e = entityRefEnd(s, i);
  if (e < 0) return null;
  return ['name', s.slice(i, e), e];
}

// Normalise a link label: trim, collapse whitespace runs to one space,
// full Unicode case folding (not just toLowerCase): ß/ẞ -> ss, ligatures
// (ﬀ/ﬁ/ﬂ/ﬃ/ﬄ/ﬅ/ﬆ) -> their expansions, final sigma ς -> σ, plus the
// Greek symbol folds and Armenian ligatures.
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .replace(/ς/g, 'σ')
    .replace(/ϐ/g, 'β').replace(/ϑ/g, 'θ').replace(/ϕ/g, 'φ')
    .replace(/ϖ/g, 'π').replace(/ϰ/g, 'κ').replace(/ϱ/g, 'ρ')
    .replace(/ϵ/g, 'ε')
    .replace(/ﬓ/g, 'մն').replace(/ﬔ/g, 'մե').replace(/ﬕ/g, 'մի')
    .replace(/ﬖ/g, 'վն').replace(/ﬗ/g, 'մխ');
}

// ---- inline parser ----
// Atoms (t): 0 text(s) 1 code(s) 2 html(s) 3 hardbreak 4 softbreak
//   5 delim(c,n,o,l) 6 link(h,ti,ch) 7 img(s,ti,ch) 8 mark(s) 9 bracket(im,on)
//   10 raw entity reference (verbatim, e.g. '&copy;')
// Text atoms hold RAW text; escaping happens at serialisation. A raw
// entity reference is its own atom so a decoded '&' next to 'name;' is
// still escaped (&#38;copy; -> &amp;copy;) while a source '&copy;' is not.

function altText(atoms) {
  // Plain text of link/image children, escaped for an attribute value.
  // Code/HTML content is escaped; raw entity references stay verbatim.
  let out = '';
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.t === 0 || a.t === 1 || a.t === 2) out += esc(a.s);
    else if (a.t === 3 || a.t === 4) out += '\n';
    else if (a.t === 5) out += a.c.repeat(a.n);
    else if (a.t === 6 || a.t === 7) out += altText(a.ch);
    else if (a.t === 9) out += a.im ? '![' : '[';
    else if (a.t === 10) out += a.s;
  }
  return out;
}

function plainText(atoms) {
  let out = '';
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.t === 0 || a.t === 1 || a.t === 2) out += a.s;
    else if (a.t === 3) out += '\n';
    else if (a.t === 4) out += '\n';
    else if (a.t === 5) out += a.c.repeat(a.n);
    else if (a.t === 6) out += plainText(a.ch);
    else if (a.t === 7) out += plainText(a.ch);
    else if (a.t === 9) out += a.im ? '![' : '[';
    else if (a.t === 10) out += a.s;
  }
  return out;
}

function serialize(atoms) {
  let out = '';
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.t === 0) out += esc(a.s);
    else if (a.t === 1) out += '<code>' + esc(a.s) + '</code>';
    else if (a.t === 2) out += a.s;
    else if (a.t === 3) out += '<br>';
    else if (a.t === 4) out += '\n';
    else if (a.t === 5) out += esc(a.c.repeat(a.n));
    else if (a.t === 6) {
      out += '<a href="' + a.h + '"';
      if (a.ti !== null) out += ' title="' + escEnt(a.ti) + '"';
      out += '>' + serialize(a.ch) + '</a>';
    } else if (a.t === 7) {
      out += '<img src="' + a.s + '" alt="' + altText(a.ch) + '"';
      if (a.ti !== null) out += ' title="' + escEnt(a.ti) + '"';
      out += '>';
    } else if (a.t === 8) out += a.s;
    else if (a.t === 9) out += a.im ? '![' : '[';
    else if (a.t === 10) out += a.s;
  }
  return out;
}

// Emphasis / strong / strikethrough over one atom list (one scope: link
// text is a separate scope). Delimiters are matched nearest-opener-first;
// a run of >=2 makes <strong>/<del>, a run of 1 makes <em>.
// Scoping: when an emphasis forms, the delimiters strictly between its
// opener and closer move one level deeper (depth++). An opener and a
// closer only pair when they are at the SAME depth — so a delimiter
// inside an emphasis cannot pair with one outside it (cm-469), while
// two delimiters inside the same emphasis can still pair with each
// other (nested emphasis, e.g. ** inside ~~ ~~).
function processEmphasis(atoms) {
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.t === 6 || a.t === 7) processEmphasis(a.ch);
  }
  const delims = [];
  for (let i = 0; i < atoms.length; i++) if (atoms[i].t === 5) { atoms[i].depth = 0; delims.push(atoms[i]); }
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.l || closer.n <= 0) continue;
    let oi = di - 1;
    while (oi >= 0 && closer.n > 0) {
      const opener = delims[oi];
      if (opener.n > 0 && opener.o && !opener.blocked && opener.c === closer.c && opener.depth === closer.depth) {
        // Rule of 3: if either run can both open and close, the match is
        // barred when the length sum is a multiple of 3, unless both
        // lengths are multiples of 3.
        const bothWays = (opener.o && opener.l) || (closer.o && closer.l);
        if (bothWays && (opener.n + closer.n) % 3 === 0 &&
          !(opener.n % 3 === 0 && closer.n % 3 === 0)) { oi--; continue; }
        // marked quirk (probed 2026-11-16, i1-i3): a single * closer
        // must NOT consume 1 asterisk from a ** opener (n==2) when a
        // later ** closer (same char/depth) can still pair with that
        // opener to form <strong> (e.g. `**a *b*c**` keeps the ** for
        // <strong>; the lone * stays literal). A *** opener (n>=3) has
        // enough asterisks for both (cm-430 `***foo* bar**` -> the *
        // pairs for <em> and the remaining ** for <strong>), so it is
        // NOT skipped. Only when no such later ** closer exists may
        // the single * pair with the ** opener.
        if (closer.c !== '~' && closer.n === 1 && opener.n === 2) {
          let laterStrong = false;
          for (let li = di + 1; li < delims.length; li++) {
            const ld = delims[li];
            if (ld.c === closer.c && ld.n >= 2 && ld.l && ld.depth === closer.depth) { laterStrong = true; break; }
          }
          if (laterStrong) { oi--; continue; }
        }
        let use = 1;
        if (opener.c === '~') {
          // a <del> forms only when both runs have the SAME length (1 or 2)
          if (opener.n !== closer.n) { oi--; continue; }
          use = opener.n;
        } else if (opener.n >= 2 && closer.n >= 2) use = 2;
        opener.n -= use;
        closer.n -= use;
        // marked quirk (probed 2026-11-16, e/f/g): when a ** pair forms
        // <strong>, its opener cannot close (preceded by whitespace) and
        // its closer can also OPEN (char after it is not whitespace,
        // e.g. `*a **b**c*`), an enclosing single-* emphasis does NOT
        // form (the outer * stay literal). If the ** opener CAN close
        // (e.g. `*class tokens**use**but*`) or the closer cannot open
        // (e.g. `*a **b** c*`), the outer <em> DOES form. Also no block
        // when the closer run had leftover asterisks (e.g. `***` after
        // `**slower**` inside ~~ ~~: the leftover * pairs with the
        // outer opener). Block the nearest enclosing single-* opener
        // (same char, n==1, same depth) so it cannot pair with its
        // closer (it stays literal).
        if (use === 2 && closer.n === 0 && !opener.l && closer.o) {
          for (let bi = oi - 1; bi >= 0; bi--) {
            const b = delims[bi];
            if (b.c === closer.c && b.n === 1 && b.o && b.depth === closer.depth) { b.blocked = true; break; }
            if (b.depth !== closer.depth) break;
          }
        }
        const ot = opener.c === '~' ? '<del>' : use === 2 ? '<strong>' : '<em>';
        const ct = opener.c === '~' ? '</del>' : use === 2 ? '</strong>' : '</em>';
        const oi2 = atoms.indexOf(opener);
        const ci = atoms.indexOf(closer);
        // Delimiters between opener and closer move one level deeper:
        // they can still pair with each other, but not with anything
        // outside this emphasis.
        for (let k = oi2 + 1; k < ci; k++) if (atoms[k].t === 5) atoms[k].depth++;
        atoms.splice(ci, 0, { t: 8, s: ct });
        atoms.splice(oi2 + 1, 0, { t: 8, s: ot });
        if (opener.n === 0) atoms.splice(atoms.indexOf(opener), 1);
        if (closer.n === 0) atoms.splice(atoms.indexOf(closer), 1);
        continue; // same closer may match again with what is left
      }
      oi--;
    }
  }
}

// ---- link destination / title parsing (shared by inline links and defs) ----
// src is the inline source, i the index to start at. Returns
// {dest, title, end} (end = index just past the closing paren / title) or null.

function skipWS(src, i) {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  return i;
}

// Parse a link destination at src[i]. Returns [dest, end] or null.
// Handles <angle> destinations and bare destinations with balanced parens.
function parseDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src[i] === '<') {
    let j = i + 1;
    let dest = '';
    while (j < n) {
      const c = src[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return [dest, j + 1];
      if (c === '\\' && j + 1 < n && isPunct(src[j + 1])) { dest += src[j + 1]; j += 2; continue; }
      dest += c;
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let dest = '';
  while (j < n) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    if (c === '(') { depth++; dest += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; dest += c; j++; continue;
    }
    if (c === '\\' && j + 1 < n && isPunct(src[j + 1])) { dest += src[j + 1]; j += 2; continue; }
    dest += c;
    j++;
  }
  return [dest, j];
}

// Parse a link title at src[i] ("..." / '...' / (...)). Returns [title, end] or null.
// A title may span lines but not contain a blank line.
function parseTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  let title = '';
  while (j < n) {
    const c = src[j];
    if (c === close) {
      if (/\n[ \t]*\n/.test(title)) return null; // a blank line in the title
      return [title, j + 1];
    }
    if (q === '(' && c === '(') return null; // no nesting in (...) titles
    if (c === '\\' && j + 1 < n && isPunct(src[j + 1])) { title += src[j + 1]; j += 2; continue; }
    title += c;
    j++;
  }
  return null;
}

// Scan a link label starting just after '[' at src[i]. Returns [rawLabel, end]
// where end is just past the closing ']', or null.
// Used for definitions and the second label of a full reference link:
// unlike link text, these may not contain an unescaped '[' (marked
// rejects nested brackets there); the label ends at the first unescaped ']'.
function parseLabel(src, i) {
  const n = src.length;
  let j = i;
  let raw = '';
  while (j < n) {
    const c = src[j];
    // a backslash + punctuation is an escape for finding the closing ']',
    // but the backslash is KEPT in the label: 'foo\!' does not match a
    // definition '[foo!]'; only '[foo\!]' matches it
    if (c === '\\' && j + 1 < n && isPunct(src[j + 1])) {
      raw += src[j] + src[j + 1]; j += 2; continue;
    }
    if (c === '[') return null;
    if (c === ']') return [raw, j + 1];
    raw += c;
    j++;
  }
  return null;
}

// ---- GFM extended autolinks ----
// Trim a scanned URL candidate the way marked does: strip trailing
// punctuation, drop unmatched open parens, drop unbalanced trailing ')'.
function trimUrl(u) {
  for (;;) {
    let changed = false;
    // a trailing named-entity-like '&name;' is not part of the URL
    const em = /&[A-Za-z]+;$/.exec(u);
    if (em) { u = u.slice(0, u.length - em[0].length); changed = true; }
    while (u.length > 0) {
      const c = u[u.length - 1];
      if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' ||
        c === ';' || c === '*' || c === '_' || c === '~' || c === "'" || c === '"') {
        u = u.slice(0, -1); changed = true;
      } else break;
    }
    // drop a trailing run starting at an unmatched '(' (re-check after cuts)
    let li = u.lastIndexOf('(');
    if (li >= 0 && u.indexOf(')', li) < 0) {
      u = u.slice(0, li); changed = true;
    }
    while (u.length > 0 && u[u.length - 1] === ')') {
      const l = u.lastIndexOf('(');
      const r = u.lastIndexOf(')', u.length - 2);
      if (l < 0 || r > l) { u = u.slice(0, -1); changed = true; } else break;
    }
    if (!changed) break;
  }
  return u;
}

function isUrlEnd(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<';
}

// Match a www. autolink at src[i] (src[i]==='w'). Returns [url, end] or null.
// Preceding char must be start, whitespace, '*', '_', '~' or '('.
function matchWWW(src, i, prev) {
  if (prev !== '' && !isSpace(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') return null;
  if (src.slice(i, i + 4) !== 'www.') return null;
  const c = src[i + 4];
  if (c === undefined || !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return null;
  let j = i;
  while (j < src.length && !isUrlEnd(src[j])) j++;
  const url = trimUrl(src.slice(i, j));
  if (url.length <= 4) return null;
  return [url, i + url.length];
}

// Match an http/https/ftp/mailto/generic-scheme autolink at src[i].
// Returns [url, end, href] or null. The head slice is bounded so calling
// this for every letter stays cheap.
function matchScheme(src, i) {
  const head = src.slice(i, i + 40);
  const m = /^(https?|ftp):\/\//i.exec(head);
  if (m) {
    const c = src[i + m[0].length];
    if (c === undefined || !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return null;
    let j = i;
    while (j < src.length && !isUrlEnd(src[j])) j++;
    const url = trimUrl(src.slice(i, j));
    if (url.length <= m[0].length) return null;
    return [url, i + url.length, url];
  }
  if (head.slice(0, 7) === 'mailto:') {
    const e = matchEmail(src, i + 7, false);
    if (!e) return null;
    const url = 'mailto:' + e[0];
    return [url, e[1], url];
  }
  // generic scheme: scheme (2-32 chars) + ':' + a bare email, then an
  // optional path (e.g. 'xmpp:foo@bar.baz/txt')
  const gm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(head);
  if (gm) {
    const scheme = gm[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp' && scheme !== 'mailto') {
      const e = matchEmail(src, i + gm[0].length, false);
      if (e) {
        let j = e[1];
        // the path after the email is a single '/'-segment, if any
        // ('xmpp:foo@bar.baz/txt/bin' links only '.../txt')
        if (src[j] === '/') {
          j++;
          while (j < src.length && src[j] !== '/' && !isUrlEnd(src[j])) j++;
        }
        const url = trimUrl(src.slice(i, j));
        if (url.length > gm[0].length) return [url, i + url.length, url];
      }
    }
  }
  return null;
}

// Match a bare email at src[i]. Returns [email, end] or null.
// prevIsLocal: the char before i is already part of a local part (no match).
// Local: [A-Za-z0-9._+-]+ ; domain: labels [A-Za-z0-9_-]+, >=1 dot, last label
// must end with an alnum.
// backoffTrail: when true and the domain's last label ends with '_',
// back the '_' run off and return the match ending at the last alnum
// (the '_' is then an emphasis closer, e.g. '_foo@bar.com_').
function matchEmail(src, i, prevIsLocal, backoffTrail) {
  if (prevIsLocal) return null;
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
      c === '.' || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  if (j === i || src[j] !== '@') return null;
  let k = j + 1;
  let labels = 0;
  let lastEndAlnum = false;
  for (;;) {
    const ls = k;
    while (k < n) {
      const c = src[k];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
        c === '-' || c === '_') k++;
      else break;
    }
    if (k === ls) return null;
    labels++;
    lastEndAlnum = isAlnum(src[k - 1]);
    if (src[k] === '.' && k + 1 < n && src[k + 1] !== '.' &&
      ((src[k + 1] >= 'a' && src[k + 1] <= 'z') || (src[k + 1] >= 'A' && src[k + 1] <= 'Z') ||
        (src[k + 1] >= '0' && src[k + 1] <= '9') || src[k + 1] === '-' || src[k + 1] === '_')) {
      k++;
      continue;
    }
    break;
  }
  if (labels < 2 || !lastEndAlnum) {
    // a trailing '_' run is an emphasis closer when a '_' opener is
    // still open; back it off so '_foo@bar.com_' links 'foo@bar.com'
    if (backoffTrail && labels >= 2 && src[k - 1] === '_') {
      let e = k;
      while (e > i && src[e - 1] === '_') e--;
      if (e > i && isAlnum(src[e - 1])) return [src.slice(i, e), e];
    }
    return null;
  }
  return [src.slice(i, k), k];
}

// ---- inline scanner ----
// Try to form a link/image from the bracket atom at atoms[bi] when ']' was
// found at src[j]. Returns the index just past the link syntax, or -1.
function tryFormLink(atoms, bi, src, j, refs) {
  const bracket = atoms[bi];
  const textAtoms = atoms.slice(bi + 1);
  // a LINK whose text already contains a bracket link does not form
  // (an autolink inside the text does NOT block it, and neither does an image)
  if (!bracket.im) {
    for (let q = 0; q < textAtoms.length; q++) if (textAtoms[q].t === 6 && !textAtoms[q].au) return -1;
  }
  // the raw label text between '[' and ']' (backslashes kept): a shortcut
  // or collapsed reference looks this up, NOT the plain text (whose
  // backslash escapes are resolved and whose formatting is stripped)
  const rawLabel = src.slice(bracket.im ? bracket.si + 2 : bracket.si + 1, j - 1);
  // the '(' or '[' must come IMMEDIATELY after ']' (no space/newline)
  const k = j;
  let dest = null;
  let title = null;
  let end = -1;
  if (src[k] === '(') {
    // inline link; on failure, fall back to the shortcut reference
    let p = skipWS(src, k + 1);
    const d = parseDest(src, p);
    if (d) {
      dest = d[0];
      p = skipWS(src, d[1]);
      let ok = true;
      if (src[p] === '"' || src[p] === "'" || src[p] === '(') {
        const t = parseTitle(src, p);
        if (!t) ok = false;
        else { title = t[0]; p = skipWS(src, t[1]); }
      }
      if (ok && src[p] === ')') end = p + 1;
    }
    if (end < 0) {
      const ref = refs.get(normalizeLabel(rawLabel));
      if (!ref) return -1;
      dest = ref.dest; title = ref.title;
      end = j;
    }
  } else if (src[k] === '[') {
    const lab = parseLabel(src, k + 1);
    if (!lab) return -1;
    const label = lab[0] === '' ? rawLabel : lab[0];
    const ref = refs.get(normalizeLabel(label));
    if (!ref) return -1;
    dest = ref.dest; title = ref.title;
    end = lab[1];
  } else {
    const ref = refs.get(normalizeLabel(rawLabel));
    if (!ref) return -1;
    dest = ref.dest; title = ref.title;
    end = j;
  }
  // deactivate any brackets inside the link text
  for (let i = 0; i < textAtoms.length; i++) {
    const a = textAtoms[i];
    if (a.t === 9) { a.t = 0; a.s = a.im ? '![' : '['; delete a.im; delete a.on; }
  }
  const href = encodeHref(dest);
  if (bracket.im) {
    atoms.splice(bi, atoms.length - bi, { t: 7, s: href, ti: title, ch: textAtoms });
  } else {
    atoms.splice(bi, atoms.length - bi, { t: 6, h: href, ti: title, ch: textAtoms });
  }
  return end;
}

// Parse <...> autolink or raw HTML at src[i] === '<'. Returns [atom, end] or null.
function parseAngle(src, i) {
  const n = src.length;
  // autolink: <scheme:...> or <email>
  if (i + 1 < n) {
    let j = i + 1;
    // scheme
    if ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z')) {
      let k = j + 1;
      while (k < n && k < j + 32 &&
        ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') ||
          (src[k] >= '0' && src[k] <= '9') || src[k] === '+' || src[k] === '.' || src[k] === '-')) k++;
      if (k < n && src[k] === ':' && k > j + 1) {
        let e = k + 1;
        while (e < n && src[e] !== '>' && src[e] !== ' ' && src[e] !== '\t' &&
          src[e] !== '\n' && src[e] !== '<' && src[e].charCodeAt(0) >= 32) e++;
        if (e < n && src[e] === '>' && e > k + 1) {
          const url = src.slice(i + 1, e);
          return [{ t: 6, au: true, h: encodeHref(url), ti: null, ch: [{ t: 0, s: url }] }, e + 1];
        }
      }
    }
    // email: local@domain with a dot, full local set
    {
      let k = j;
      while (k < n) {
        const c = src[k];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
          '.!#$%&\'*+-/=?^_`{|}~'.indexOf(c) >= 0) k++;
        else break;
      }
      if (k > j && src[k] === '@') {
        let d = k + 1;
        let labels = 0;
        let ok = true;
        for (;;) {
          const ls = d;
          while (d < n) {
            const c = src[d];
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') d++;
            else break;
          }
          if (d === ls) { ok = false; break; }
          labels++;
          if (src[d] === '.' && d + 1 < n && src[d + 1] !== '>' && src[d + 1] !== '.' &&
            ((src[d + 1] >= 'a' && src[d + 1] <= 'z') || (src[d + 1] >= 'A' && src[d + 1] <= 'Z') ||
              (src[d + 1] >= '0' && src[d + 1] <= '9') || src[d + 1] === '-')) {
            d++;
            continue;
          }
          break;
        }
        if (ok && labels >= 2 && src[d] === '>') {
          const email = src.slice(i + 1, d);
          return [{ t: 6, au: true, h: 'mailto:' + encodeHref(email), ti: null, ch: [{ t: 0, s: email }] }, d + 1];
        }
      }
    }
  }
  // raw HTML: comment, PI, declaration, CDATA
  if (src.slice(i, i + 4) === '<!--') {
    // <!--> and <!---> are complete (empty) comments
    if (src.slice(i, i + 5) === '<!-->') return [{ t: 2, s: '<!-->' }, i + 5];
    if (src.slice(i, i + 6) === '<!--->') return [{ t: 2, s: '<!--->' }, i + 6];
    const e = src.indexOf('-->', i + 4);
    if (e >= 0) return [{ t: 2, s: src.slice(i, e + 3) }, e + 3];
    return null;
  }
  if (src.slice(i, i + 2) === '<?') {
    const e = src.indexOf('?>', i + 2);
    if (e >= 0) return [{ t: 2, s: src.slice(i, e + 2) }, e + 2];
    return null;
  }
  if (src.slice(i, i + 9) === '<![CDATA[') {
    const e = src.indexOf(']]>', i + 9);
    if (e >= 0) return [{ t: 2, s: src.slice(i, e + 3) }, e + 3];
    return null;
  }
  if (src.slice(i, i + 2) === '<!' && i + 2 < n &&
    ((src[i + 2] >= 'a' && src[i + 2] <= 'z') || (src[i + 2] >= 'A' && src[i + 2] <= 'Z'))) {
    const e = src.indexOf('>', i + 2);
    if (e >= 0) return [{ t: 2, s: src.slice(i, e + 1) }, e + 1];
    return null;
  }
  // open / close tag
  let j = i + 1;
  let closing = false;
  if (src[j] === '/') { closing = true; j++; }
  if (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) {
    j++;
    while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') ||
      (src[j] >= '0' && src[j] <= '9') || src[j] === '-')) j++;
    let hadWS = false;
    for (;;) {
      if (j >= n) return null;
      const c = src[j];
      if (c === '>') return [{ t: 2, s: src.slice(i, j + 1) }, j + 1];
      if (!closing && c === '/' && src[j + 1] === '>') return [{ t: 2, s: src.slice(i, j + 2) }, j + 2];
      if (c === ' ' || c === '\t' || c === '\n') { j++; hadWS = true; continue; }
      // a closing tag takes no attributes; an attribute (or junk) must be
      // preceded by whitespace after the tag name
      if (closing) return null;
      if (!hadWS) return null;
      // attribute name
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === ':')) return null;
      j++;
      while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') ||
        (src[j] >= '0' && src[j] <= '9') || src[j] === '_' || src[j] === ':' ||
        src[j] === '.' || src[j] === '-')) j++;
      // only consume the whitespace after the name if '=' follows
      // (otherwise it is the separator before the next attribute)
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
      if (src[k] === '=') {
        j = k + 1;
        while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
        if (src[j] === '"' || src[j] === "'") {
          const q = src[j];
          j++;
          while (j < n && src[j] !== q) j++;
          if (j >= n) return null;
          j++;
        } else {
          let any = false;
          while (j < n) {
            const v = src[j];
            if (v === ' ' || v === '\t' || v === '\n' || v === '"' || v === "'" ||
              v === '=' || v === '<' || v === '>' || v === '`') break;
            any = true; j++;
          }
          if (!any) return null;
        }
      }
      hadWS = false;
    }
  }
  return null;
}

function inlineParse(src, refs, state) {
  const atoms = [];
  let text = '';
  const flush = () => { if (text !== '') { atoms.push({ t: 0, s: text }); text = ''; } };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      let k = text.length;
      while (k > 0 && text[k - 1] === ' ') k--;
      if (text.length - k >= 2) {
        text = text.slice(0, k); flush(); atoms.push({ t: 3 });
        i++;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else { flush(); atoms.push({ t: 4 }); i++; }
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const len = j - i;
      let k = j;
      let close = -1;
      let closeEnd = -1;
      while (k < n) {
        if (src[k] === '`') {
          let e = k;
          while (e < n && src[e] === '`') e++;
          if (e - k === len) { close = k; closeEnd = e; break; }
          k = e;
        } else k++;
      }
      if (close < 0) { text += src.slice(i, j); i = j; continue; }
      let content = src.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      atoms.push({ t: 1, s: content });
      i = closeEnd;
      continue;
    }
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush(); atoms.push({ t: 3 }); i += 2;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) { text += nx; i += 2; continue; }
      text += '\\'; i++; continue;
    }
    if (c === '&') {
      const e = decodeEntity(src, i);
      if (e) {
        if (e[0] === 'name') { flush(); atoms.push({ t: 10, s: e[1] }); }
        else text += e[1];
        i = e[2]; continue;
      }
      text += '&'; i++; continue;
    }
    if (c === '<') {
      const a = parseAngle(src, i);
      if (a) { flush(); atoms.push(a[0]); i = a[1]; continue; }
      text += '<'; i++; continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      flush();
      // si: source index of the '[' ('!' for images) — the raw label text
      // between '[' and ']' is what a shortcut/collapsed reference looks up
      atoms.push({ t: 9, im: c === '!', on: true, si: i });
      state.open++;
      i += c === '!' ? 2 : 1;
      continue;
    }
    if (c === ']') {
      flush(); // link text still buffered must be in atoms for tryFormLink
      let bi = -1;
      for (let k = atoms.length - 1; k >= 0; k--) {
        if (atoms[k].t === 9 && atoms[k].on) { bi = k; break; }
      }
      if (bi >= 0) {
        const innerActive = countActiveBrackets(atoms, bi + 1);
        const end = tryFormLink(atoms, bi, src, i + 1, refs, state);
        if (end >= 0) {
          state.open -= 1 + innerActive;
          i = end;
          continue;
        }
        atoms[bi].on = false;
        state.open--;
      }
      text += ']'; i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const len = j - i;
      // a '~' run of 3+ is literal text, never a delimiter
      if (c === '~' && len >= 3) { text += src.slice(i, j); i = j; continue; }
      const prev = i > 0 ? src[i - 1] : '';
      const next = j < n ? src[j] : '';
      const prevSpace = prev === '' || isSpace(prev);
      const nextSpace = next === '' || isSpace(next);
      // '_' uses the tilde-inclusive punctuation set (see isFlankPunctU)
      const punctFn = c === '_' ? isFlankPunctU : isFlankPunct;
      const prevPunct = prev !== '' && punctFn(prev);
      const nextPunct = next !== '' && punctFn(next);
      const leftFlank = !nextSpace && (!nextPunct || prevSpace || prevPunct);
      const rightFlank = !prevSpace && (!prevPunct || nextSpace || nextPunct);
      let o;
      let l;
      if (c === '_') {
        o = leftFlank && (!rightFlank || prevPunct);
        l = rightFlank && (!leftFlank || nextPunct);
      } else {
        o = leftFlank;
        l = rightFlank;
      }
      flush();
      atoms.push({ t: 5, c, n: len, o, l });
      i = j;
      continue;
    }
    if (state.open === 0) {
      if (c === 'w' && src[i + 1] === 'w' && src[i + 2] === 'w' && src[i + 3] === '.') {
        const prev = i > 0 ? src[i - 1] : '';
        const m = matchWWW(src, i, prev);
        if (m) {
          flush();
          const url = m[0];
          atoms.push({ t: 6, au: true, h: encodeHref('http://' + url), ti: null, ch: [{ t: 0, s: url }] });
          i = m[1];
          continue;
        }
      } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
        // fast pre-check: a scheme needs ':' within the next 33 chars;
        // skip the (regex) matchScheme for the vast majority of letters
        const ci = src.indexOf(':', i + 2);
        if (ci !== -1 && ci - i <= 33) {
          const m = matchScheme(src, i);
          if (m) {
            flush();
            atoms.push({ t: 6, au: true, h: encodeHref(m[2]), ti: null, ch: [{ t: 0, s: m[0] }] });
            i = m[1];
            continue;
          }
        }
      }
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
        c === '.' || c === '+' || c === '-' || c === '_') {
        const prev = i > 0 ? src[i - 1] : '';
        const prevLocal = prev !== '' && ((prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') ||
          (prev >= '0' && prev <= '9') || prev === '.' || prev === '_' || prev === '+' || prev === '-') &&
          // a '_' that is an emphasis delimiter (not a word character)
          // does not make the email part of a preceding word
          !(prev === '_' && atoms.length > 0 && atoms[atoms.length - 1].t === 5 &&
            atoms[atoms.length - 1].c === '_');
        if (!prevLocal) {
          // a trailing '_' is an emphasis closer (not part of the email)
          // when a '_' opener is still open in this scope
          let backoffTrail = false;
          for (let q = 0; q < atoms.length; q++) {
            const a = atoms[q];
            if (a.t === 5 && a.c === '_' && a.o && a.n > 0) { backoffTrail = true; break; }
          }
          const m = matchEmail(src, i, false, backoffTrail);
          if (m) {
            flush();
            atoms.push({ t: 6, au: true, h: 'mailto:' + encodeHref(m[0]), ti: null, ch: [{ t: 0, s: m[0] }] });
            i = m[1];
            continue;
          }
        }
      }
    }
    text += c;
    i++;
  }
  flush();
  processEmphasis(atoms);
  return serialize(atoms);
}

function countActiveBrackets(atoms, from) {
  let n = 0;
  for (let i = from; i < atoms.length; i++) if (atoms[i].t === 9 && atoms[i].on) n++;
  return n;
}

// ---- block parser ----

function lineIndent(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col, i];
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// Substring of line starting at column col, starting the scan at char
// startIdx which sits at column startCol. Tabs are column-aware; a tab
// straddling the target column leaves spaces behind.
function sliceFromCol(line, col, startIdx, startCol) {
  let c = startCol;
  let i = startIdx;
  while (i < line.length && c < col) {
    const ch = line[i];
    if (ch === '\t') {
      const adv = 4 - (c % 4);
      if (c + adv > col) return ' '.repeat(c + adv - col) + line.slice(i + 1);
      c += adv; i++;
    } else if (ch === ' ') { c++; i++; }
    else break;
  }
  return line.slice(i);
}
function sliceCol(line, col) { return sliceFromCol(line, col, 0, 0); }

// Like sliceCol, but a tab straddling the target column is removed whole
// (no partial spaces left behind) — marked's rule for fenced code content.
function sliceColFence(line, col) {
  let c = 0;
  let i = 0;
  while (i < line.length && c < col) {
    const ch = line[i];
    if (ch === '\t') {
      const adv = 4 - (c % 4);
      if (c + adv > col) return line.slice(i + 1);
      c += adv; i++;
    } else if (ch === ' ') { c++; i++; }
    else break;
  }
  return line.slice(i);
}

// Expand tabs in the leading whitespace run to spaces (tab stops from
// column 0); the rest of the line is left untouched.
function expandLeadingWs(line) {
  let i = 0;
  let col = 0;
  let out = '';
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') { const adv = 4 - (col % 4); out += ' '.repeat(adv); col += adv; i++; }
    else break;
  }
  return out + line.slice(i);
}

// Is rest (a container-stripped line) a closing fence for a fence opened
// with ch/len? (same char, length >= opener length, only whitespace after)
function isFenceClose(rest, ch, len) {
  const [ind, idx] = lineIndent(rest);
  if (ind > 3) return false;
  const s = rest.slice(idx);
  if (s[0] !== ch) return false;
  let k = 0;
  while (k < s.length && s[k] === ch) k++;
  if (k < len) return false;
  return /^[ \t]*$/.test(s.slice(k));
}

// A fence opener at the start of rest (indent <= 3), or null.
function fenceOpen(rest) {
  const [ind, idx] = lineIndent(rest);
  if (ind > 3) return null;
  return matchFence(rest.slice(idx));
}
function stripQuoteMarker(line, idx) {
  let rest = line.slice(idx + 1);
  let k = 0;
  let col = idx + 1;
  let ws = '';
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
    if (rest[k] === ' ') { ws += ' '; col++; k++; }
    else { const adv = 4 - (col % 4); ws += ' '.repeat(adv); col += adv; k++; }
  }
  if (ws.length > 0) rest = ws.slice(1) + rest.slice(k);
  return rest;
}

// Content of a list item's first line: expand the whitespace run after the
// marker to spaces (absolute tab stops); 1-4 columns -> content starts
// after all of it, >=5 columns -> after marker + 1 column.
function listItemFirstLine(line, m, ind) {
  if (m.empty) return '';
  const [li0, lidx0] = lineIndent(line);
  let k = lidx0 + m.w;
  let col = ind + m.w;
  let ws = '';
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { ws += ' '; col++; k++; }
    else { const adv = 4 - (col % 4); ws += ' '.repeat(adv); col += adv; k++; }
  }
  const rest0 = line.slice(k);
  return (m.wsCols >= 1 && m.wsCols <= 4) ? rest0 : ws.slice(1) + rest0;
}

// Strip exactly 4 columns of leading whitespace from a lazy continuation
// line, if it has >= 4 columns (tab-aware); otherwise return it unchanged.
function stripLazy(line) {
  const expanded = expandLeadingWs(line);
  let cols = 0;
  while (cols < expanded.length && expanded[cols] === ' ') cols++;
  if (cols >= 4) return expanded.slice(4);
  return line;
}

// Whether a line may be a lazy continuation line of an open paragraph:
// it must not start a block (ATX, fence, hr, blockquote, list, HTML
// blocks 1-6). A setext underline that is not an HR may be lazy (it is
// then kept as paragraph text, never a heading — see noSetext).
function canBeLazy(line) {
  if (isBlank(line)) return false;
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return true;
  const rest = line.slice(idx);
  if (isHR(rest)) return false;
  if (rest[0] === '#') { if (matchATX(rest)) return false; }
  if (rest[0] === '`' || rest[0] === '~') { if (matchFence(rest)) return false; }
  if (rest[0] === '>') return false;
  if (matchListMarker(rest, ind)) return false;
  const ht = htmlBlockType(rest);
  if (ht > 0 && ht !== 7) return false;
  return true;
}

// Whether a paragraph is open after this (already container-stripped)
// line. wasOpen is whether a paragraph was open before it. Nested
// blockquote markers are stripped; a fresh list item resets the state
// (its content starts a new block).
function paraOpenAfter(line, wasOpen) {
  let s = line;
  let open = wasOpen;
  for (;;) {
    if (isBlank(s)) return false;
    const [ind, idx] = lineIndent(s);
    if (ind > 3) return open;
    const rest = s.slice(idx);
    if (rest[0] === '>') { s = stripQuoteMarker(s, idx); continue; }
    const lm = matchListMarker(rest, ind);
    if (lm) {
      if (lm.empty) return false;
      s = listItemFirstLine(s, lm, ind);
      open = false;
      continue;
    }
    return classifyLine(s, open) === 'para';
  }
}

// ATX heading: returns [level, text] or null.
function matchATX(rest) {
  let k = 0;
  while (k < rest.length && rest[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  if (k < rest.length && rest[k] !== ' ' && rest[k] !== '\t') return null;
  // The closing sequence is checked on the untrimmed text (the space after
  // the marker counts as the space before a closing run: '### ###' -> '').
  // Trailing spaces after the closing run are allowed: '### foo ###  ' -> 'foo'.
  let s = rest.slice(k);
  const m = /[ \t]+#+[ \t]*$/.exec(s);
  if (m) s = s.slice(0, m.index);
  s = s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return [k, s];
}

// Process backslash escapes in a fence info word (backslash before a
// punctuation character is removed; anything else is kept).
function unescapeLang(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Fenced code: returns {ch, len, info} or null.
function matchFence(rest) {
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let k = 0;
  while (k < rest.length && rest[k] === ch) k++;
  if (k < 3) return null;
  const info = rest.slice(k);
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len: k, info: info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') };
}

// Thematic break line (rest already has <=3 indent stripped).
function isHR(rest) {
  // count non-space chars without building a string (hot path: called
  // for every line); must be >=3 of one of -, *, _
  let c = '';
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === ' ' || ch === '\t') continue;
    if (n === 0) { c = ch; if (c !== '-' && c !== '*' && c !== '_') return false; }
    else if (ch !== c) return false;
    n++;
  }
  return n >= 3;
}

// Setext underline: returns 1 for '=', 2 for '-', else 0. The trimmed
// line must be a run of one repeated char with NO interior spaces:
// '= =' and '--- -' are not underlines.
function setextLevel(rest) {
  const s = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (s.length < 1) return 0;
  const c = s[0];
  if (c !== '=' && c !== '-') return 0;
  for (let i = 1; i < s.length; i++) if (s[i] !== c) return 0;
  return c === '=' ? 1 : 2;
}

// List marker: returns {bullet, delim, start, w, wsCols, empty} or null.
// bullet: '-', '+', '*' or null; delim: '.' or ')' or null; start: number.
// baseCol is the absolute column of rest[0] (tab stops are absolute).
function matchListMarker(rest, baseCol) {
  baseCol = baseCol || 0;
  const c = rest[0];
  let w;
  let bullet = null;
  let delim = null;
  let start = 0;
  if (c === '-' || c === '+' || c === '*') {
    w = 1; bullet = c;
  } else if (c >= '0' && c <= '9') {
    let k = 0;
    while (k < rest.length && rest[k] >= '0' && rest[k] <= '9') k++;
    if (k > 9) return null;
    if (rest[k] !== '.' && rest[k] !== ')') return null;
    delim = rest[k];
    start = parseInt(rest.slice(0, k), 10);
    w = k + 1;
  } else return null;
  // whitespace after the marker (tab stops are absolute columns)
  let col = baseCol + w;
  let j = w;
  while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) {
    if (rest[j] === ' ') { col++; j++; }
    else { col += 4 - (col % 4); j++; }
  }
  if (j === w && j < rest.length) return null; // marker not followed by space/tab (e.g. '*foo')
  // a marker at end-of-line IS a list item (an empty one)
  const wsCols = col - (baseCol + w);
  const empty = j >= rest.length;
  return { bullet, delim, start, w, wsCols, empty, afterIdx: j };
}

// HTML block start tags (type 6) — block-level tag names.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Classify a stripped line for container/lazy purposes.
// Returns 'blank' | 'para' | 'setext' | 'nonpara'. paraOpen says whether a
// paragraph is open before this line (matters for indented lines).
function classifyLine(line, paraOpen) {
  if (isBlank(line)) return 'blank';
  const [ind, idx] = lineIndent(line);
  const rest = line.slice(idx);
  if (setextLevel(rest) > 0 && ind <= 3) return 'setext';
  if (ind > 3) return paraOpen ? 'para' : 'nonpara';
  if (rest[0] === '#') { const a = matchATX(rest); if (a) return 'nonpara'; }
  if (rest[0] === '`' || rest[0] === '~') { if (matchFence(rest)) return 'nonpara'; }
  if (isHR(rest)) return 'nonpara';
  if (rest[0] === '>') return 'nonpara';
  const lm = matchListMarker(rest, ind);
  if (lm) {
    // a list line leaves a paragraph open iff the item starts with paragraph text
    if (lm.empty) return 'nonpara';
    const after = listItemFirstLine(line, lm, ind);
    if (after === '') return 'nonpara';
    return paraOpenAfter(after, false) ? 'para' : 'nonpara';
  }
  const ht = htmlBlockType(rest);
  if (ht > 0) return (paraOpen && ht === 7) ? 'para' : 'nonpara';
  return 'para';
}

// Parse an HTML tag starting at s[i] === '<'. Returns [endIndex, name, closing]
// or null when it is not a well-formed tag.
function parseHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z'))) return null;
  const ns = j;
  j++;
  while (j < n && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') ||
    (s[j] >= '0' && s[j] <= '9') || s[j] === '-')) j++;
  const name = s.slice(ns, j).toLowerCase();
  let hadWS = false;
  for (;;) {
    if (j >= n) return null;
    const c = s[j];
    if (c === '>') return [j + 1, name, closing];
    if (!closing && c === '/' && s[j + 1] === '>') return [j + 2, name, closing];
    if (c === ' ' || c === '\t' || c === '\n') { j++; hadWS = true; continue; }
    // a closing tag takes no attributes; an attribute (or junk) must be
    // preceded by whitespace after the tag name
    if (closing) return null;
    if (!hadWS) return null;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === ':')) return null;
    j++;
    while (j < n && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') ||
      (s[j] >= '0' && s[j] <= '9') || s[j] === '_' || s[j] === ':' || s[j] === '.' || s[j] === '-')) j++;
    // only consume the whitespace after the name if '=' follows
    // (otherwise it is the separator before the next attribute)
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      j = k + 1;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        let any = false;
        while (j < n) {
          const v = s[j];
          if (v === ' ' || v === '\t' || v === '\n' || v === '"' || v === "'" ||
            v === '=' || v === '<' || v === '>' || v === '`') break;
          any = true; j++;
        }
        if (!any) return null;
      }
    }
    hadWS = false;
  }
}

// Tag name at the start of rest ('<' + optional '/' + name), or null.
// The name must be followed by whitespace, '>', '/' or end-of-line
// (so '<div:foo>' and '<m:abc>' are rejected). Used to recognise a
// multi-line open tag whose '>' is not on this line.
function htmlTagName(rest) {
  let j = 1;
  let closing = false;
  if (rest[j] === '/') { closing = true; j++; }
  if (j >= rest.length || !((rest[j] >= 'a' && rest[j] <= 'z') || (rest[j] >= 'A' && rest[j] <= 'Z'))) return null;
  const ns = j;
  j++;
  while (j < rest.length && ((rest[j] >= 'a' && rest[j] <= 'z') || (rest[j] >= 'A' && rest[j] <= 'Z') ||
    (rest[j] >= '0' && rest[j] <= '9') || rest[j] === '-')) j++;
  const name = rest.slice(ns, j).toLowerCase();
  const after = rest[j];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '>' && after !== '/') return null;
  return [name, closing];
}

// HTML block type at the start of rest (indent already <= 3), or 0.
// Types 1-6 can interrupt a paragraph; type 7 cannot. Type 1 is ONLY
// pre/script/style/textarea; all other block tags are type 6.
function htmlBlockType(rest) {
  if (rest[0] !== '<') return 0;
  if (rest.slice(0, 4) === '<!--') return 2;
  if (rest.slice(0, 2) === '<?') return 3;
  if (rest.slice(0, 9) === '<![CDATA[') return 5;
  if (rest.slice(0, 2) === '<!' && rest.length > 2 &&
    ((rest[2] >= 'a' && rest[2] <= 'z') || (rest[2] >= 'A' && rest[2] <= 'Z'))) return 4;
  const t = parseHtmlTag(rest, 0);
  if (t) {
    const name = t[1];
    // a closing tag for a type-1 element (</pre>, </script>, ...) is NOT
    // a block; it stays in the paragraph
    if (t[2] && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) return 0;
    if (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea') return 1;
    if (BLOCK_TAGS.has(name)) return 6;
    // type 7: the whole line is this one tag (open or close), nothing else
    let k = t[0];
    while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
    return k >= rest.length ? 7 : 0;
  }
  // the tag may be incomplete on this line (a multi-line open tag):
  // recognise it by the tag name alone
  const nm = htmlTagName(rest);
  if (nm) {
    const name = nm[0];
    if (nm[1] && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) return 0;
    if (!nm[1] && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) return 1;
    if (BLOCK_TAGS.has(name)) return 6;
  }
  return 0;
}

// Skip spaces/tabs and at most one line break (never across a blank line),
// for link reference definitions.
function skipWSDef(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (s[i] === '\n') {
    let j = i + 1;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j < s.length && s[j] !== '\n') i = j;
  }
  return i;
}

// ---- link reference definitions ----
// Try to parse a definition starting at lines[i]. Returns {lines, label, dest,
// title} or null. A definition spans lines until a blank line (a multi-line
// title may span several lines, but not a blank line).
function tryDef(lines, i, refs) {
  const line = lines[i];
  if (line === undefined) return null;
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return null;
  if (line[idx] !== '[') return null;
  let joinEnd = i;
  while (joinEnd < lines.length && joinEnd < i + 10 && !isBlank(lines[joinEnd])) joinEnd++;
  const joined = lines.slice(i, joinEnd).join('\n');
  const off = idx;
  const lab = parseLabel(joined, off + 1);
  if (!lab) return null;
  const label = normalizeLabel(lab[0]);
  if (label === '' || lab[0].length > 999) return null;
  let p = lab[1];
  if (joined[p] !== ':') return null;
  p++;
  p = skipWSDef(joined, p);
  const d = parseDest(joined, p);
  if (!d) return null;
  // an empty bare destination is not allowed (but <> is)
  if (d[0] === '') {
    // parseDest returns '' only for <>; bare empty cannot happen (parseDest
    // at a space returns [''])
    if (joined[p] !== '<') return null;
  }
  // A title must be preceded by whitespace; it may start on the dest's
  // line or on the next line (the dest itself may be on a continuation
  // line, so "the next line" is the line after the dest's line).
  let title = null;
  let endPos = d[1];
  const afterDest = joined[d[1]];
  if (afterDest === '"' || afterDest === "'" || afterDest === '(') {
    // a title directly after the dest, with no whitespace — invalid
    return null;
  }
  if (afterDest === ' ' || afterDest === '\t' || afterDest === '\n' || afterDest === undefined) {
    // skip whitespace on the dest's line; if the line ends, move to the
    // next line's leading whitespace too. A title found on the dest's
    // line must be valid (else the def fails); a title on the next line
    // may fail, leaving the def valid without a title.
    let pTitle = d[1];
    while (pTitle < joined.length && (joined[pTitle] === ' ' || joined[pTitle] === '\t')) pTitle++;
    const onDestLine = pTitle < joined.length && joined[pTitle] !== '\n';
    if (joined[pTitle] === '\n') {
      pTitle++;
      while (pTitle < joined.length && (joined[pTitle] === ' ' || joined[pTitle] === '\t')) pTitle++;
    }
    if (joined[pTitle] === '"' || joined[pTitle] === "'" || joined[pTitle] === '(') {
      const t = parseTitle(joined, pTitle);
      if (onDestLine) {
        // title on the dest's line: must be valid and followed by only
        // whitespace to end-of-line, or the def fails
        if (!t) return null;
        let q = t[1];
        while (q < joined.length && (joined[q] === ' ' || joined[q] === '\t')) q++;
        if (q < joined.length && joined[q] !== '\n') return null;
        title = t[0];
        endPos = t[1];
      } else if (t) {
        let q = t[1];
        while (q < joined.length && (joined[q] === ' ' || joined[q] === '\t')) q++;
        if (q >= joined.length || joined[q] === '\n') {
          title = t[0];
          endPos = t[1];
        }
        // else: the next-line title is followed by junk — the def is
        // still valid WITHOUT the title (the title line is left over)
      }
      // else: parseTitle failed — the def is valid without the title
    }
  } else {
    // junk directly after the dest — invalid def
    return null;
  }
  // only whitespace may remain on the line where the definition ends
  // (the next line may start a new definition)
  let q = endPos;
  while (q < joined.length && (joined[q] === ' ' || joined[q] === '\t')) q++;
  if (q < joined.length && joined[q] !== '\n') return null;
  const linesUsed = joined.slice(0, q).split('\n').length;
  if (!refs.has(label)) refs.set(label, { dest: d[0], title });
  return { lines: linesUsed, label, dest: d[0], title };
}

// ---- tables ----
function splitRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  // skip leading whitespace and an optional leading pipe
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] === '|') i++;
  for (; i < line.length; i++) {
    const c = line[i];
    // '\|' is an escaped pipe: it belongs to this cell (resolved to '|'
    // now, before inline parsing). '\\' keeps both backslashes so the
    // following '|' is a separator, not an escaped pipe.
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '\\') { cur += line.slice(i, i + 2); i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  // trailing pipe: drop the empty cell it would create
  let trailingPipe = false;
  let j = line.length - 1;
  while (j >= 0 && (line[j] === ' ' || line[j] === '\t')) j--;
  if (j >= 0 && line[j] === '|' && (j === 0 || line[j - 1] !== '\\')) trailingPipe = true;
  if (!trailingPipe) cells.push(cur.trim());
  else if (cur.trim() !== '') cells.push(cur.trim());
  return cells;
}

function isDelimCell(cell) {
  const s = cell.trim();
  if (s.length < 1) return false;
  let k = 0;
  if (s[k] === ':') k++;
  let dashes = 0;
  while (k < s.length && s[k] === '-') { k++; dashes++; }
  if (dashes < 1) return false;
  if (k < s.length && s[k] === ':') k++;
  return k === s.length;
}

function delimAlign(cell) {
  const s = cell.trim();
  const l = s[0] === ':';
  const r = s[s.length - 1] === ':';
  if (l && r) return 'center';
  if (l) return 'left';
  if (r) return 'right';
  return null;
}

// Try to parse a table starting at lines[i] (ind <= 3). Returns {tok, end} or null.
function matchTable(lines, i, ind) {
  const headLine = lines[i];
  const delimLine = lines[i + 1];
  if (delimLine === undefined) return null;
  const [dInd] = lineIndent(delimLine);
  if (dInd > 3) return null;
  // a bare '---' delimiter is a setext underline, not a table delimiter
  const dRest = delimLine.slice(lineIndent(delimLine)[1]);
  if (setextLevel(dRest) === 2) return null;
  const head = splitRow(headLine.slice(lineIndent(headLine)[1]));
  const delim = splitRow(dRest);
  if (head.length !== delim.length || head.length === 0) return null;
  for (let k = 0; k < delim.length; k++) if (!isDelimCell(delim[k])) return null;
  const align = delim.map(delimAlign);
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j];
    // a line with only spaces (or empty) ends the table, but a line
    // containing a tab is a row of empty cells (marked)
    if (line === '' || /^[ ]*$/.test(line)) break;
    const [li, lidx] = lineIndent(line);
    if (li <= 3) {
      const rest = line.slice(lidx);
      // any list marker that can interrupt ends the table (a list block
      // starts), even one classifyLine calls 'para'; but an ordered
      // list starting at a number other than 1 does NOT interrupt, so
      // it stays a table row (marked, u1 vs u2)
      const lm = matchListMarker(rest, li);
      if (lm && (lm.bullet || lm.start === 1)) break;
      if (classifyLine(line, false) === 'nonpara') break;
    }
    rows.push(splitRow(line));
    j++;
  }
  return {
    tok: { k: 'table', align, head, rows },
    end: j,
  };
}

// ---- container collectors ----
// Collect blockquote lines starting at lines[i] (line i has a '>' marker).
// Returns {lines, end, noBreak}: the stripped lines, the first line not
// in the quote, and the indices (into lines) of lazy continuation lines,
// which must not become headings nor interrupt the paragraph.
function collectQuote(lines, i) {
  const out = [];
  const noBreak = new Set();
  let paraOpen = false;
  let prevWasLazy = false;
  let fenceCh = null;
  let fenceLen = 0;
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const [ind, idx] = lineIndent(line);
    if (ind <= 3 && line[idx] === '>') {
      const rest = stripQuoteMarker(line, idx);
      out.push(rest);
      // track fenced code blocks: inside a fence there is no open
      // paragraph, and a markerless line ends the quote (it cannot be a
      // lazy continuation of a code block)
      if (fenceCh !== null) {
        if (isFenceClose(rest, fenceCh, fenceLen)) { fenceCh = null; fenceLen = 0; }
        paraOpen = false;
      } else {
        const f = fenceOpen(rest);
        if (f) { fenceCh = f.ch; fenceLen = f.len; paraOpen = false; }
        else if (!(rest !== '' && isBlank(rest))) paraOpen = paraOpenAfter(rest, paraOpen);
      }
      prevWasLazy = false;
      j++;
      continue;
    }
    // a markerless blank line ends the quote
    if (isBlank(line)) break;
    // a lazy line inside a fence ends the quote (a code block has no
    // lazy continuations)
    if (fenceCh !== null) break;
    if (paraOpen && canBeLazy(line)) {
      const [li, lidx] = lineIndent(line);
      const sl = li <= 3 ? setextLevel(line.slice(lidx)) : 0;
      if (sl > 0) {
        // a lazy setext line stays paragraph text (never a heading);
        // it gets 4 spaces prepended only when the previous line was
        // lazy too
        noBreak.add(out.length);
        out.push(prevWasLazy ? '    ' + line.replace(/^[ \t]+/, '') : line);
        paraOpen = true;
        prevWasLazy = true;
        j++;
        continue;
      }
      const stripped = stripLazy(line);
      noBreak.add(out.length);
      out.push(stripped);
      paraOpen = paraOpenAfter(stripped, paraOpen);
      prevWasLazy = true;
      j++;
      continue;
    }
    break;
  }
  return { lines: out, end: j, noBreak };
}

// Collect one list item starting at lines[i] (marker info m, line indent ind).
// Returns {lines, end, task, noBreak}.
function collectItem(lines, i, m, ind) {
  // an empty item's content indent is marker + 1, regardless of the
  // whitespace after the marker
  const contentIndent = m.empty ? ind + m.w + 1
    : (m.wsCols >= 1 && m.wsCols <= 4 ? ind + m.w + m.wsCols : ind + m.w + 1);
  const first = listItemFirstLine(lines[i], m, ind);
  const out = [first];
  const noBreak = new Set();
  let paraOpen = paraOpenAfter(first, false);
  let prevWasLazy = false;
  // track fenced code blocks: inside a fence there is no open paragraph,
  // and a lazy line ends the item (a code block has no lazy continuations)
  let fenceCh = null;
  let fenceLen = 0;
  // a lazy line (too little indent) is fence content only once the fence
  // already has a properly-indented content line; a lazy line right after
  // the opener leaves the fence empty and ends the item
  let fenceHasContent = false;
  {
    const f0 = fenceOpen(first);
    if (f0) { fenceCh = f0.ch; fenceLen = f0.len; paraOpen = false; }
  }
  let pending = [];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      // an empty item ends at a blank line (a following indented line
      // is a new block, not this item's content)
      if (m.empty) break;
      pending.push('');
      paraOpen = false; // a blank line closes the paragraph
      prevWasLazy = false;
      j++;
      continue;
    }
    const [li, lidx] = lineIndent(line);
    if (li >= contentIndent) {
      if (pending.length > 0) { out.push(...pending); pending = []; }
      // strip the item indent; tabs in the leading run expand to spaces
      const stripped = expandLeadingWs(line).slice(contentIndent);
      out.push(stripped);
      if (fenceCh !== null) {
        if (isFenceClose(stripped, fenceCh, fenceLen)) { fenceCh = null; fenceLen = 0; }
        else fenceHasContent = true;
        paraOpen = false;
      } else {
        const f = fenceOpen(stripped);
        if (f) { fenceCh = f.ch; fenceLen = f.len; fenceHasContent = false; paraOpen = false; }
        else paraOpen = paraOpenAfter(stripped, paraOpen);
      }
      prevWasLazy = false;
      j++;
      continue;
    }
    // inside a fenced code block, a line with too little indent is still
    // fence content — but only once the fence has a properly-indented
    // content line; a lazy line right after the opener ends the item
    // (a quote differs because a markerless line is not in the quote at all)
    if (fenceCh !== null) {
      if (!fenceHasContent) break;
      if (pending.length > 0) { out.push(...pending); pending = []; }
      out.push(line);
      if (isFenceClose(line, fenceCh, fenceLen)) { fenceCh = null; fenceLen = 0; }
      paraOpen = false;
      prevWasLazy = false;
      j++;
      continue;
    }
    if (paraOpen && canBeLazy(line)) {
      if (pending.length > 0) { out.push(...pending); pending = []; }
      const [li2, lidx2] = lineIndent(line);
      const sl = li2 <= 3 ? setextLevel(line.slice(lidx2)) : 0;
      if (sl > 0) {
        noBreak.add(out.length);
        out.push(prevWasLazy ? '    ' + line.replace(/^[ \t]+/, '') : line);
        paraOpen = true;
        prevWasLazy = true;
        j++;
        continue;
      }
      const stripped = stripLazy(line);
      noBreak.add(out.length);
      out.push(stripped);
      paraOpen = paraOpenAfter(stripped, paraOpen);
      prevWasLazy = true;
      j++;
      continue;
    }
    break;
  }
  // trailing blanks are not part of the item
  const end = j - pending.length;
  // task marker: [ ] / [x] / [X] followed by space/tab and content, first line
  let task = null;
  const fl = out[0];
  if (fl !== undefined) {
    const tm = /^\[( |x|X)\][ \t]+\S/.exec(fl);
    if (tm) {
      task = tm[1] === ' ' ? ' ' : 'x';
      out[0] = fl.replace(/^\[( |x|X)\][ \t]+/, '');
    }
  }
  return { lines: out, end, task, noBreak };
}

// ---- block tokeniser ----
// docEndNL: true only for the top-level call when the document ends with a
// newline (decides the trailing newline of a final HTML block).
// noBreak: indices (into lines) of lazy continuation lines, which must not
// become headings nor interrupt the paragraph. nested: true for a recursive
// (container) call — a whitespace-only non-empty line then continues a
// paragraph instead of ending it.
// The returned array carries .hasBlankBetween (a blank line fell between
// two top-level blocks in this call), used for list tight/loose.
function tokenizeBlocks(lines, refs, docEndNL, noBreak, nested, inItem) {
  noBreak = noBreak || new Set();
  nested = !!nested;
  inItem = !!inItem;
  const toks = [];
  const n = lines.length;
  let i = 0;
  let sawBlank = false;
  let hasBlankBetween = false;
  while (i < n) {
    if (isBlank(lines[i])) { sawBlank = true; i++; continue; }
    // link reference definitions (a definition is a block-level element:
    // a blank line before it counts for hasBlankBetween)
    let consumed = 0;
    while (true) {
      const d = tryDef(lines, i + consumed, refs);
      if (!d) break;
      consumed += d.lines;
    }
    if (consumed > 0) {
      if (sawBlank && toks.length > 0) hasBlankBetween = true;
      sawBlank = false;
      i += consumed; continue;
    }
    // a block is about to be emitted; a skipped blank line before it (and
    // after a previous block) means the list is loose
    if (sawBlank && toks.length > 0) hasBlankBetween = true;
    sawBlank = false;
    const line = lines[i];
    const [ind, idx] = lineIndent(line);
    if (ind <= 3) {
      const rest = line.slice(idx);
      const atx = matchATX(rest);
      if (atx) { toks.push({ k: 'head', lv: atx[0], src: atx[1] }); i++; continue; }
      const fence = matchFence(rest);
      if (fence) {
        const content = [];
        let j = i + 1;
        while (j < n) {
          const [ci, cidx] = lineIndent(lines[j]);
          if (ci <= 3) {
            const crest = lines[j].slice(cidx);
            let k = 0;
            while (k < crest.length && crest[k] === fence.ch) k++;
            if (k >= fence.len && crest.slice(k).replace(/[ \t]+$/, '') === '') break;
          }
          // a tilde fence does NOT strip the opener's indent from its
          // content lines (marked); a backtick fence does
          content.push(fence.ch === '`' ? sliceColFence(lines[j], ind) : lines[j]);
          j++;
        }
        const lang = fence.info === '' ? null : unescapeLang(fence.info.split(/[ \t]/)[0]);
        // drop exactly one trailing blank line from a fenced code block
        let src = content.join('\n');
        if (content.length > 0 && content[content.length - 1] !== '') src += '\n';
        toks.push({ k: 'code', lang, src });
        i = j + (j < n ? 1 : 0);
        continue;
      }
      if (rest[0] === '>') {
        const q = collectQuote(lines, i);
        toks.push({ k: 'quote', ch: tokenizeBlocks(q.lines, refs, false, q.noBreak, true, inItem) });
        i = q.end;
        continue;
      }
      if (isHR(rest)) { toks.push({ k: 'hr' }); i++; continue; }
      const lm = matchListMarker(rest, ind);
      if (lm) {
        const bullet = lm.bullet;
        const delim = lm.delim;
        const start = lm.start;
        const items = [];
        let loose = false;
        let j = i;
        while (j < n) {
          const [li2, lidx2] = lineIndent(lines[j]);
          if (li2 > 3) break;
          const rest2 = lines[j].slice(lidx2);
          // an HR at the list's level ends the list (it is not a new item)
          if (isHR(rest2)) break;
          const m2 = matchListMarker(rest2, li2);
          if (!m2 || m2.bullet !== bullet || m2.delim !== delim) break;
          const item = collectItem(lines, j, m2, li2);
          item.ch = tokenizeBlocks(item.lines, refs, false, item.noBreak, true, true);
          // a blank line between two top-level blocks inside an item, or
          // between items, makes the list loose
          if (item.ch.hasBlankBetween) loose = true;
          items.push(item);
          j = item.end;
          // blank lines between items make the list loose (definitions
          // between the items do not hide the blank line)
          let b = j;
          let sawBlankBetween = false;
          while (b < n) {
            if (isBlank(lines[b])) { sawBlankBetween = true; b++; continue; }
            const d = tryDef(lines, b, refs);
            if (d) { b += d.lines; continue; }
            break;
          }
          let nextIsItem = false;
          if (sawBlankBetween && b < n) {
            const [bi2, bidx2] = lineIndent(lines[b]);
            const m3 = bi2 <= 3 ? matchListMarker(lines[b].slice(bidx2), bi2) : null;
            if (m3 && m3.bullet === bullet && m3.delim === delim) { loose = true; nextIsItem = true; }
          }
          if (b > j) {
            // if the list ends here, the skipped blank lines lie between
            // this list and the next block (they count for hasBlankBetween)
            if (sawBlankBetween && !nextIsItem) sawBlank = true;
            j = b;
          }
        }
        // a list's first item must be non-empty to have interrupted a paragraph;
        // here we are at block level, so items always form a list.
        toks.push({ k: 'list', ord: delim !== null, start, tight: !loose, items });
        i = j;
        continue;
      }
      const ht = htmlBlockType(rest);
      if (ht > 0) {
        const content = [line];
        let j = i + 1;
        if (ht === 1) {
          const tag = parseHtmlTag(rest, 0);
          const nm = (htmlTagName(rest) || ['', false])[0];
          const closeRe = new RegExp('</' + nm + '\\s*>', 'i');
          // the opening line may already contain the closing tag
          if (!tag || !closeRe.test(rest.slice(tag[0]))) {
            while (j < n && !closeRe.test(lines[j])) { content.push(lines[j]); j++; }
            if (j < n) { content.push(lines[j]); j++; }
          }
        } else if (ht >= 2 && ht <= 5) {
          const marker = ht === 2 ? '-->' : ht === 3 ? '?>' : ht === 4 ? '>' : ']]>';
          const openLen = ht === 2 ? 4 : ht === 3 ? 2 : ht === 4 ? 2 : 9;
          // the opening line may already close the block (<!--> and <!---> too)
          let closed = rest.indexOf(marker, openLen) >= 0;
          if (ht === 2 && (rest.slice(0, 5) === '<!-->' || rest.slice(0, 6) === '<!--->')) closed = true;
          if (!closed) {
            while (j < n && lines[j].indexOf(marker) < 0) { content.push(lines[j]); j++; }
            if (j < n) { content.push(lines[j]); j++; }
          }
        } else {
          while (j < n && !isBlank(lines[j])) { content.push(lines[j]); j++; }
        }
        // trailing newline: the block's lines are joined with '\n', plus
        // a trailing '\n' unless the next line is blank — but for types
        // 1-5 (closed by a marker) only a truly EMPTY line suppresses it;
        // a whitespace-only line still gets the '\n'. Types 6-7 (ended by
        // a blank line) suppress it for any blank line. At the document
        // end, only when the document ends with '\n'.
        const trail = (j < n ? (ht <= 5 ? lines[j] !== '' : !isBlank(lines[j])) : docEndNL) ? '\n' : '';
        toks.push({ k: 'html', src: content.join('\n') + trail });
        i = j;
        continue;
      }
      const tbl = matchTable(lines, i, ind);
      if (tbl) { toks.push(tbl.tok); i = tbl.end; continue; }
    }
    if (ind >= 4) {
      const content = [];
      let j = i;
      let pending = [];
      while (j < n) {
        const line2 = lines[j];
        if (isBlank(line2)) { pending.push(sliceCol(line2, 4)); j++; continue; }
        const [li2] = lineIndent(line2);
        if (li2 < 4) break;
        if (pending.length > 0) { content.push(...pending); pending = []; }
        content.push(sliceCol(line2, 4));
        j++;
      }
      toks.push({ k: 'code', lang: null, src: content.length === 0 ? '' : content.join('\n') + '\n' });
      i = j - pending.length;
      continue;
    }
    // paragraph (with setext headings and interruption rules)
    const paraLines = [];
    let j = i;
    let headTok = null;
    while (j < n) {
      const line2 = lines[j];
      if (isBlank(line2)) {
        // in a nested container, a whitespace-only NON-EMPTY line
        // continues the paragraph; at the top level it is blank (ends it)
        if (nested && line2 !== '' && paraLines.length > 0) {
          paraLines.push(line2);
          j++;
          continue;
        }
        break;
      }
      const [li2, lidx2] = lineIndent(line2);
      if (li2 <= 3 && !noBreak.has(j)) {
        const rest2 = line2.slice(lidx2);
        const sl = setextLevel(rest2);
        if (sl > 0 && paraLines.length > 0) {
          // a setext heading's text is the paragraph text trimmed at both ends
          headTok = { k: 'head', lv: sl, src: paraLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') };
          j++;
          break;
        }
        if (paraLines.length > 0) {
          // interruption checks
          if (matchATX(rest2)) break;
          if (matchFence(rest2)) break;
          if (rest2[0] === '>') break;
          if (isHR(rest2) && sl === 0) break;
          const lm2 = matchListMarker(rest2, li2);
          if (lm2) {
            // a list interrupts a paragraph iff its first item is non-empty
            // and (bullet, or ordered starting at 1 — or any ordered list
            // when the paragraph is inside a list item)
            if (!lm2.empty && (lm2.bullet !== null || lm2.start === 1 || inItem)) break;
          }
          const ht2 = htmlBlockType(rest2);
          if (ht2 > 0 && ht2 !== 7) break;
        }
      }
      // paragraph lines keep their leading whitespace verbatim (marked
      // does not strip it, not even on the first line)
      paraLines.push(line2);
      j++;
    }
    if (headTok) { toks.push(headTok); i = j; continue; }
    if (paraLines.length > 0) {
      toks.push({ k: 'para', src: paraLines.join('\n') });
      i = j;
      continue;
    }
    i++;
  }
  toks.hasBlankBetween = hasBlankBetween;
  return toks;
}

// ---- rendering ----
function renderTokens(toks, refs, state, tight) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'para') {
      const html = inlineParse(t.src, refs, state);
      out += tight ? html : '<p>' + html + '</p>\n';
    } else if (t.k === 'head') {
      out += '<h' + t.lv + '>' + inlineParse(t.src, refs, state) + '</h' + t.lv + '>\n';
    } else if (t.k === 'code') {
      out += '<pre><code';
      if (t.lang !== null) out += ' class="language-' + t.lang + '"';
      out += '>' + esc(t.src) + '</code></pre>\n';
    } else if (t.k === 'html') {
      out += t.src;
    } else if (t.k === 'hr') {
      out += '<hr>\n';
    } else if (t.k === 'quote') {
      out += '<blockquote>\n' + renderTokens(t.ch, refs, state, false) + '</blockquote>\n';
    } else if (t.k === 'list') {
      out += t.ord ? '<ol' + (t.start !== 1 ? ' start="' + t.start + '"' : '') + '>\n' : '<ul>\n';
      for (let q = 0; q < t.items.length; q++) {
        const item = t.items[q];
        let inner;
        const cb = item.task === null ? '' :
          (item.task === 'x'
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ');
        if (item.ch.length > 0 && item.ch[0].k === 'para') {
          const first = item.ch[0];
          const rest = renderTokens(item.ch.slice(1), refs, state, t.tight);
          if (t.tight) {
            inner = cb + inlineParse(first.src, refs, state) + rest;
          } else {
            inner = '<p>' + cb + inlineParse(first.src, refs, state) + '</p>\n' + rest;
          }
        } else {
          inner = cb + renderTokens(item.ch, refs, state, t.tight);
        }
        out += '<li>' + inner + '</li>\n';
      }
      out += t.ord ? '</ol>\n' : '</ul>\n';
    } else if (t.k === 'table') {
      out += '<table>\n<thead>\n<tr>\n';
      for (let q = 0; q < t.head.length; q++) {
        const a = t.align[q];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
          inlineParse(t.head[q], refs, state) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (t.rows.length > 0) {
        out += '<tbody>';
        for (let r = 0; r < t.rows.length; r++) {
          out += '<tr>\n';
          for (let q = 0; q < t.head.length; q++) {
            const cell = q < t.rows[r].length ? t.rows[r][q] : '';
            const a = t.align[q];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
              inlineParse(cell, refs, state) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
    }
  }
  return out;
}

// ---- entry point ----
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const state = { open: 0 };
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const toks = tokenizeBlocks(lines, refs, src.endsWith('\n'));
  return renderTokens(toks, refs, state, false);
}
