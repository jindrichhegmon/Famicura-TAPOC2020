/**
 * Malý parser XML pro odpovědi ONVIF (SOAP). Bez závislostí.
 *
 * Kamera míchá prefixy (tt:, tns1:, wsnt:, tev:) podle toho, jak jí to
 * vyhovuje; tady se prefixy zahazují a hledá se podle místního jména. Stačí
 * to: v odpovědích ONVIF se žádné dvě věci nejmenují stejně jinak než
 * prefixem. Nepodporuje DTD ani entity mimo těch pět základních – v SOAP
 * odpovědi kamery se nic z toho nevyskytuje.
 */

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const odentituj = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENT[e];
});
const bezPrefixu = (name) => name.slice(name.indexOf(':') + 1);

/** Uzel: { name, attrs, children, text } – text jsou přímé textové děti spojené dohromady. */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }          // CDATA
    if (m[2] !== undefined) {                                          // closing tag
      if (stack.length === 1 || bezPrefixu(m[2]) !== top.name) throw new Error(`XML: neočekávané </${m[2]}>`);
      stack.pop(); continue;
    }
    if (m[3] !== undefined) {                                          // opening tag
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (a[1].startsWith('xmlns')) continue;
        attrs[bezPrefixu(a[1])] = odentituj(a[2] ?? a[3]);
      }
      const node = { name: bezPrefixu(m[3]), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
      continue;
    }
    if (m[6] !== undefined) top.text += odentituj(m[6]);
  }
  if (stack.length !== 1) throw new Error(`XML: neuzavřený <${stack[stack.length - 1].name}>`);
  return root;
}

/** První potomek (v libovolné hloubce) daného jména; s více jmény postupně: najdi(doc, 'Body', 'Fault'). */
export function najdi(node, ...names) {
  let cur = node;
  for (const name of names) {
    cur = cur && prvni(cur, name);
    if (!cur) return null;
  }
  return cur;
}

function prvni(node, name) {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = prvni(c, name);
    if (deep) return deep;
  }
  return null;
}

/** Všichni potomci daného jména, v pořadí dokumentu. */
export function vsechny(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    vsechny(c, name, out);
  }
  return out;
}

export const textUzlu = (node) => (node ? node.text.trim() : '');
