import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { ATTACH_BYTES, ATTACH_MAX, type SlackAttachment } from '@cora/shared';

/**
 * Files a message may carry to Slack, and where they may come from. Only from folders where screenshots, downloads
 * and a session's own work live (the session's folder, the temp folder Playwright saves to, Cora's attachments,
 * Pictures, Downloads, Desktop); never anything that looks like a secret, wherever it is.
 */

const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** an image's type, by its name (null: not one Cora previews) */
export const imageType = (name: string) => IMAGES[extname(name).toLowerCase()] ?? null;

/** Names and folders that hold secrets: never uploaded. */
const SECRET_NAME = /^\.env(\..*)?$|\.(pem|key|p12|pfx|kdbx|ppk|asc|gpg)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|token|password|\.npmrc$|\.netrc$|^mcp\.json$|^slack.*\.json$|^elevenlabs\.json$/i;
const SECRET_DIR = /^(\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|\.config|\.claude)$/i;
/** Cora's own data folder (its keys, tokens, database), wherever CORA_HOME puts it */
const coraHome = (home: string) => process.env.CORA_HOME || join(home, '.cora');

/** Where a session's attachments may come from (its own folder too, when it has one). */
export function attachmentRoots(cwd?: string, home = homedir(), dataDir = coraHome(home)): string[] {
  return [
    tmpdir(),
    join(dataDir, 'attachments'),
    // Playwright, run by Cora's agent, saves into its folder's .playwright-mcp
    join(dataDir, 'orchestrator', '.playwright-mcp'),
    join(home, 'Pictures'),
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    // a session's own folder (not Cora's data folder, which holds its keys)
    ...(cwd && !inside(resolve(cwd), dataDir) ? [cwd] : []),
  ].map((r) => resolve(r));
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
function inside(p: string, root: string): boolean {
  const a = norm(resolve(p));
  const b = norm(resolve(root));
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** Check the files a message wants to carry: each one, or why it can't go. */
export function checkAttachments(paths: string[], roots: string[], dataDir = coraHome(homedir())): SlackAttachment[] {
  // never from Cora's data folder (its keys and database), whatever folder the session runs in: only its attachments and
  // the screenshots Cora's agent takes (docs/audit-2026-10-20.md S9)
  const sendable = [join(dataDir, 'attachments'), join(dataDir, 'orchestrator', '.playwright-mcp')];
  if (paths.length > ATTACH_MAX) throw new Error(`at most ${ATTACH_MAX} files`);
  const real = roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  return paths.map((p) => {
    if (!isAbsolute(p)) throw new Error(`${p}: give the file's full path`);
    let path: string;
    try {
      path = realpathSync(p);
    } catch {
      throw new Error(`${p}: no such file`);
    }
    const st = statSync(path);
    if (!st.isFile()) throw new Error(`${p}: not a file`);
    if (st.size > ATTACH_BYTES) throw new Error(`${basename(p)} is ${Math.round(st.size / 1e6)} MB: ${ATTACH_BYTES / 1e6} MB at most`);
    // a name that says secret (an image is just a picture, whatever it's called), or a folder of secrets
    if ((!imageType(path) && SECRET_NAME.test(basename(path))) || path.split(/[\\/]/).some((s) => SECRET_DIR.test(s))) throw new Error(`${basename(p)}: that looks like a secret, so it isn't sent`);
    if (inside(path, dataDir) && !sendable.some((r) => inside(path, r))) throw new Error(`${basename(p)}: that's in Cora's own data folder, so it isn't sent`);
    if (!real.some((r) => inside(path, r))) throw new Error(`${p}: files can come from the session's folder, the temp folder (screenshots), Pictures, Downloads or Desktop`);
    return { name: basename(path), path, size: st.size, image: !!imageType(path) };
  });
}
