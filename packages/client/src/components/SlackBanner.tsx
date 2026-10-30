import { Component, useMemo, useEffect, type ReactNode } from 'react';
import { CoraOrb } from './CoraOrb';
import { Icon } from './Icon';
import './slackBanner.css';

/**
 * Cora's Slack banner: the picture at the top of a message
 * Cora sends for you, on a page of its own (`/?banner=1`). The desktop app opens it out of sight, records a couple of
 * seconds of it and makes a GIF. Everything it says comes in the address: whose assistant, what the message is about,
 * where it came from, the colour. When its words and orb are drawn its title turns to "ready".
 */
export function SlackBanner() {
  const q = Object.fromEntries(new URLSearchParams(location.search));
  const color = /^#[0-9a-f]{6}$/i.test(q.color ?? '') ? q.color : undefined;
  if (color) document.documentElement.style.setProperty('--cora', color);
  useEffect(() => {
    document.documentElement.classList.add('banner-page');
    let done = false;
    // the fonts in, and the orb a few frames in
    void document.fonts.ready.then(() => setTimeout(() => !done && (document.title = 'ready'), 900));
    return () => void (done = true);
  }, []);
  return <SlackBannerView q={q} />;
}

/**
 * The banner itself, from its words (`q`, as the server sends them): Cora's (her orb, "CORA", what it's
 * about), or a session's. The banner page draws it to be recorded; a Slack draft
 * shows it as the banner that will go.
 */
export function SlackBannerView({ q }: { q: Record<string, string> }) {
  const session = q.kind === 'session';
  const color = /^#[0-9a-f]{6}$/i.test(q.color ?? '') ? q.color : undefined;
  const line = q.line?.slice(0, 120) || (session ? '' : 'A message from Cora');
  const sub = (session ? q.sub : q.from)?.slice(0, 120) || '';
  return (
    <div className={`slack-banner${session ? ' session' : ''}`} style={color ? ({ ['--cora' as string]: color } as React.CSSProperties) : undefined}>
      <div className="sb-orb">
        <BannerOrb color={session ? color : undefined} />
      </div>
      <div className="sb-words">
        <div className="sb-who">
          <b>{session ? 'CORA SESSION' : 'CORA'}</b>
        </div>
        {line ? <div className="sb-line">{line}</div> : null}
        {sub ? <div className="sb-from">{sub}</div> : null}
      </div>
      {session && q.icon ? (
        <span className="sb-mark">
          <Icon name={q.icon} size={104} strokeWidth={1.5} />
        </span>
      ) : null}
    </div>
  );
}

/** Can this page draw 3D at all? (After the graphics process crashes a few times, the app runs without it.) */
function canWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** The banner's orb: the living one, or, when 3D can't be drawn (or the orb fails), a still one: the banner goes either way. */
function BannerOrb({ color }: { color?: string }) {
  const gl = useMemo(canWebGL, []);
  const still = <span className="sb-still" />;
  if (!gl) return still;
  return (
    <OrbCatch fallback={still}>
      <CoraOrb state="idle" size={64} ferro always {...(color ? { color } : {})} />
    </OrbCatch>
  );
}

class OrbCatch extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
