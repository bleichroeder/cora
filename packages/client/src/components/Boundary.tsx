import { Component, type ReactNode } from 'react';

/**
 * Contain a crash: an optional part (`quiet`) just disappears; the app as a whole shows what went wrong and a
 * way back, never a blank window.
 */
export class Boundary extends Component<{ children: ReactNode; quiet?: boolean; name?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[cora] ${this.props.name ?? 'view'} crashed:`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <div className="crash">
        <b>Something in Cora broke.</b>
        <code>{error.message}</code>
        <div>
          <button className="btn" onClick={() => location.reload()}>Reload</button>
          <button className="btn ghost" onClick={() => this.setState({ error: null })}>Try to carry on</button>
        </div>
      </div>
    );
  }
}
