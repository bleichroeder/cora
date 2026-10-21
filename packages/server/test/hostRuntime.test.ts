import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostRuntime } from '../src/ptyhost/runtime';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cora-hr-'));
  const dist = join(base, 'dist');
  const modules = join(base, 'node_modules');
  mkdirSync(dist);
  mkdirSync(join(modules, '@lydell', 'node-pty'), { recursive: true });
  mkdirSync(join(modules, '@lydell', 'node-pty-win32-x64'), { recursive: true });
  mkdirSync(join(modules, '@lydell', 'other'), { recursive: true });
  writeFileSync(join(modules, '@lydell', 'node-pty', 'index.js'), 'pty');
  writeFileSync(join(modules, '@lydell', 'node-pty-win32-x64', 'conpty.node'), 'bin');
  writeFileSync(join(dist, 'ptyhost.js'), 'host v1');
  writeFileSync(join(dist, 'chunk-AB12.js'), 'chunk');
  writeFileSync(join(dist, 'cli.js'), 'server');
  writeFileSync(join(base, 'node.exe'), 'node');
  const data = join(base, 'data');
  return { o: { dataDir: data, node: join(base, 'node.exe'), distDir: dist, modulesDir: modules }, data, dist };
}

describe('the terminal host, installed', () => {
  it('runs from a copy in ~/.cora/runtime: the bundled Node, its script and chunks, the terminal library', () => {
    const { o } = setup();
    const r = hostRuntime(o);
    const dir = join(r.script, '..');
    expect(r.node).toBe(join(dir, 'node.exe'));
    expect(readdirSync(dir).sort()).toEqual(['chunk-AB12.js', 'node.exe', 'node_modules', 'package.json', 'ptyhost.js', 'ready']);
    expect(readdirSync(join(dir, 'node_modules', '@lydell')).sort()).toEqual(['node-pty', 'node-pty-win32-x64']);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type).toBe('module');
  });

  it('the same build reuses its folder; a new one gets its own, and the old one goes when nothing runs there', () => {
    const { o, data, dist } = setup();
    const a = hostRuntime(o);
    expect(hostRuntime(o)).toEqual(a);
    writeFileSync(join(dist, 'ptyhost.js'), 'host v2');
    const b = hostRuntime(o);
    expect(b.script).not.toBe(a.script);
    expect(existsSync(a.script)).toBe(false);
    expect(readdirSync(join(data, 'runtime'))).toHaveLength(1);
  });
});
