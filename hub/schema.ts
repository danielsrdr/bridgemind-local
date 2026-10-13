// Minimal dependency-free JSON Schema validator (subset). validate() returns error strings; [] = valid.
const MAX = 50;

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

const matchesType = (v: unknown, t: string): boolean =>
  t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t;

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => k in b && deepEqual(a[k], b[k]));
}

export function validate(value: unknown, schema: any, path = '$'): string[] {
  const out: string[] = [];
  check(value, schema, path, out);
  return out.slice(0, MAX);
}

function check(v: any, s: any, p: string, out: string[]): void {
  if (out.length >= MAX || s === true) return;
  if (s === false) return void out.push(`${p}: no value allowed`);
  if (typeof s !== 'object' || s === null) return;
  const err = (msg: string) => out.push(`${p}: ${msg}`);

  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => matchesType(v, t))) { err(`expected ${types.join('|')}`); return; }
  }
  if ('const' in s && !deepEqual(v, s.const)) err(`expected const ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => deepEqual(e, v))) err(`expected one of ${JSON.stringify(s.enum)}`);

  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) err(`expected length >= ${s.minLength}`);
    if (s.maxLength !== undefined && v.length > s.maxLength) err(`expected length <= ${s.maxLength}`);
    if (s.pattern !== undefined) {
      try { if (!new RegExp(s.pattern).test(v)) err(`expected pattern ${s.pattern}`); }
      catch { err(`invalid pattern ${s.pattern}`); }
    }
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) err(`expected >= ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) err(`expected <= ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) err(`expected >= ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) err(`expected <= ${s.maxItems} items`);
    if (s.items !== undefined) v.forEach((x, i) => check(x, s.items, `${p}[${i}]`, out));
  }
  if (typeOf(v) === 'object') {
    const props = s.properties ?? {};
    for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) out.push(`${p}.${k}: required`);
    for (const k of Object.keys(v)) {
      if (Object.hasOwn(props, k)) check(v[k], props[k], `${p}.${k}`, out);
      else if (s.additionalProperties === false) out.push(`${p}.${k}: unexpected property`);
      else if (s.additionalProperties !== undefined && s.additionalProperties !== true) check(v[k], s.additionalProperties, `${p}.${k}`, out);
    }
  }
}
