/** The part of a scrolling element the transcript's follow logic needs (a plain object in tests). */
export type ScrollBox = { scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number };

/** Within this many pixels of the end counts as "at the end". */
export const NEAR_END_PX = 60;

export const atEnd = (el: ScrollBox) => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;

const toEnd = (el: ScrollBox) => {
  el.scrollTop = el.scrollHeight - el.clientHeight;
};

/**
 * Whether the transcript keeps the newest activity in view. Reading further up stops it; scrolling back to the
 * end, "new activity", or switching to another session or agent starts it again.
 *
 * While following, anything that changes the feed's geometry without new events is pinned back to the end:
 * the compact terminal growing for a permission prompt or a menu, live-activity rows appearing, rows growing
 * after they were measured. None of those fire a scroll event or bump the session's version, so before this the
 * newest rows stayed hidden below the fold (with no "new activity" button) until something else scrolled.
 */
export class Follow {
  following = true;
  private view: string | null = null;

  /** The view (session + agent filter) on show. A new one starts at its end; true when it changed. */
  setView(view: string): boolean {
    if (view === this.view) return false;
    this.view = view;
    this.following = true;
    return true;
  }

  /** The feed scrolled (the reader, or us): follow exactly when it's at the end. */
  scrolled(el: ScrollBox): boolean {
    this.following = atEnd(el);
    return this.following;
  }

  /** The feed or its content changed size. */
  resized(el: ScrollBox): void {
    if (this.following) toEnd(el);
  }

  /** Jump to the end and follow from there. */
  resume(el: ScrollBox): void {
    this.following = true;
    toEnd(el);
  }
}
