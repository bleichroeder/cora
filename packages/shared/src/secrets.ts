/**
 * Cora Secrets: a JWT, a PAT, an API key kept in Cora for
 * sessions to use without ever seeing it. Cora runs their command with it and masks it in what comes back.
 */

/**
 * What a secret is: one value (a token, a key: $NAME), or a username and password for a login ($NAME_USER and
 * $NAME_PASS, both hidden in what comes back).
 */
export type SecretKind = 'value' | 'login';

/** The environment a command gets for a secret: its name and value, or a login's two. */
export const secretEnv = (name: string, s: { kind?: SecretKind; value: string; user?: string }): Record<string, string> =>
  s.kind === 'login' ? { [`${name}_USER`]: s.user ?? '', [`${name}_PASS`]: s.value } : { [name]: s.value };

/** How a command uses it ($GITHUB_PAT, or $SITE_LOGIN_USER and $SITE_LOGIN_PASS). */
export const secretVars = (name: string, kind?: SecretKind) => (kind === 'login' ? `$${name}_USER and $${name}_PASS` : `$${name}`);

/** Which sessions may use a secret: all of them, or those working in these folders. */
export type SecretScope = { all: true } | { folders: string[] };

/** A secret as the dashboard and sessions know it: never its value. */
export type SecretInfo = {
  name: string;
  /** one value (left out: secrets made before there were kinds), or a username and password */
  kind?: SecretKind;
  /** a login's username (shown in Settings; a session gets it only in its command, as $NAME_USER) */
  user?: string;
  /** what it's for (sessions see it, to pick the right one) */
  note: string;
  scope: SecretScope;
  createdAt: number;
  updatedAt: number;
  /** a JWT's expiry, read from it */
  expiresAt?: number | null;
  lastUsed?: { at: number; sessionId: string; session: string } | null;
};
export type SecretsMsg = { t: 'secrets'; list: SecretInfo[] };

/** A secret's name, as commands use it ($GITHUB_PAT): upper case, digits and underscores. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Names a command's environment needs as they are: never a secret's. */
const RESERVED = new Set(['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']);
export const secretNameProblem = (name: string): string | null =>
  !SECRET_NAME.test(name) ? 'a name in capitals, digits and underscores (like GITHUB_PAT)' : RESERVED.has(name) || name.startsWith('CORA_') ? `${name} is taken (the system or Cora uses it)` : null;

// Node's Buffer on the server, the browser's atob/btoa in the dashboard (shared code has neither's types)
type Buf = { from(s: string, enc: string): { toString(enc: string): string } };
const B = (globalThis as { Buffer?: Buf }).Buffer;
const b64 = (s: string) => (B ? B.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s))));
const unb64 = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return B ? B.from(t, 'base64').toString('utf8') : decodeURIComponent(escape(atob(t)));
};

/** A JWT's expiry (from its `exp`), or null when it isn't one or says none. */
export function jwtExpiry(value: string): number | null {
  const parts = value.trim().split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[\w-]+={0,2}$/.test(p))) return null;
  try {
    const exp = (JSON.parse(unb64(parts[1])) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The text with every secret in it hidden: as it is, base64'd and URL-encoded (how commands echo them back). */
export function mask(text: string, values: string[]): string {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < 4) continue;
    for (const f of [v, b64(v), b64(v).replace(/=+$/, ''), encodeURIComponent(v)]) if (f.length >= 4) forms.add(f);
  }
  let out = text;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join('••••');
  return out;
}

const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** May a session working in this folder use it? */
export const inScope = (s: Pick<SecretInfo, 'scope'>, folder: string) =>
  'all' in s.scope || s.scope.folders.some((f) => key(folder) === key(f) || key(folder).startsWith(`${key(f)}/`));
