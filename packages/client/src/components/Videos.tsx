import { useEffect, useMemo, useState } from 'react';
import type { VideoJob } from '@cora/shared';
import { declineFfmpeg, deleteVideo, downloadFfmpeg, sendVideoInSlack, useVideos, videoUrl } from '../state/videos';
import { ago } from '../lib/format';
import { Icon } from './Icon';
import './videos.css';

/**
 * Debrief videos: 🎬 on a debrief (Make a video: the
 * modal in VideoMaker), the player (its progress while it's made; ffmpeg asked for the first time), and the Videos
 * panel. A video is kept a while unless you save it.
 */

const STAGE: Record<VideoJob['stage'], string> = { ffmpeg: 'Needs ffmpeg', drawing: 'Drawing the slides', voicing: 'Voicing it', building: 'Putting it together', ready: 'Ready', failed: "Couldn't make it" };
const mb = (b: number) => `${(b / 1_048_576).toFixed(b < 10_485_760 ? 1 : 0)} MB`;
const mins = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const left = (at: number) => {
  const h = Math.max(0, (at - Date.now()) / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(h * 60))} min`;
};

/** 🎬 on a debrief: its video when there's one, else Make a video (the modal: as you want it). */
export function VideoButton({ sessionId, debriefId }: { sessionId: string; debriefId: string }) {
  const job = useVideos((s) => s.jobs.findLast((j) => j.debriefId === debriefId && j.stage !== 'failed'));
  return (
    <span className="vd-btn">
      <button className={job ? 'lit' : ''} title={job ? (job.stage === 'ready' ? 'Watch its video' : `Its video: ${STAGE[job.stage].toLowerCase()}…`) : 'Make a video of it (narrated slides)'} onClick={() => (job ? useVideos.getState().show(job.id) : useVideos.getState().make({ sessionId, debriefId }))}>
        <Icon name="Clapperboard" size={12} />
      </button>
    </span>
  );
}

/** The player: a video's progress while it's made (ffmpeg asked for first), then the video, to save, send or delete. */
export function VideoPlayer() {
  const id = useVideos((s) => s.open);
  const job = useVideos((s) => s.jobs.find((j) => j.id === s.open));
  useEffect(() => {
    if (!id) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && useVideos.getState().show(null);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [id]);
  if (!job) return null;
  return (
    <div className="vd-scrim" onMouseDown={(e) => e.target === e.currentTarget && useVideos.getState().show(null)}>
      <div className="vd-modal">
        <div className="vd-h">
          <Icon name="Clapperboard" size={14} />
          <b>{job.title}</b>
          <span className="spacer" />
          <button className="vd-x" title="Close (Esc)" onClick={() => useVideos.getState().show(null)}>
            <Icon name="X" size={14} />
          </button>
        </div>
        <VideoBody job={job} big />
      </div>
    </div>
  );
}

/** One video: where it's at, or it playing with what you can do with it. */
function VideoBody({ job, big }: { job: VideoJob; big?: boolean }) {
  const ffmpeg = useVideos((s) => s.ffmpeg);
  const [sent, setSent] = useState<string | null>(null);
  if (job.stage === 'ffmpeg') {
    const dl = ffmpeg.state === 'downloading' ? ffmpeg : null;
    return (
      <div className="vd-ff">
        <Icon name="Download" size={22} />
        <b>Debrief videos need ffmpeg</b>
        <span>A free video tool (about 100 MB). Cora can download it into its own folder, once; or install it yourself and make the video again.</span>
        {dl ? (
          <div className="vd-bar">
            <i style={{ width: dl.total ? `${Math.round((dl.got / dl.total) * 100)}%` : '30%' }} />
            <span>{dl.total ? `${mb(dl.got)} of ${mb(dl.total)}` : mb(dl.got)}</span>
          </div>
        ) : (
          <div className="vd-acts">
            {ffmpeg.state === 'missing' && ffmpeg.canDownload ? (
              <button className="btn allow" onClick={() => void downloadFfmpeg()}>
                <Icon name="Download" size={12} /> Download it
              </button>
            ) : null}
            <button className="btn ghost" onClick={() => void declineFfmpeg()}>
              I'll install it myself
            </button>
          </div>
        )}
        {ffmpeg.state === 'missing' && ffmpeg.error ? <span className="vd-err">{ffmpeg.error}</span> : null}
      </div>
    );
  }
  if (job.stage !== 'ready') {
    const steps: VideoJob['stage'][] = ['drawing', 'voicing', 'building'];
    const at = steps.indexOf(job.stage);
    return (
      <div className="vd-prog">
        {job.stage === 'failed' ? (
          <>
            <span className="vd-err">
              <Icon name="TriangleAlert" size={13} /> {job.error ?? "Couldn't make it"}
            </span>
            <div className="vd-acts">
              <button className="btn ghost" onClick={() => void deleteVideo(job.id)}>
                Dismiss
              </button>
            </div>
          </>
        ) : (
          steps.map((s, i) => (
            <div key={s} className={`vd-step${i < at ? ' done' : i === at ? ' now' : ''}`}>
              <Icon name={i < at ? 'CircleCheck' : i === at ? 'LoaderCircle' : 'Circle'} size={13} />
              <span>{STAGE[s]}</span>
              {i === at ? (
                <em>
                  {job.done} of {job.total}
                </em>
              ) : null}
            </div>
          ))
        )}
      </div>
    );
  }
  return (
    <div className={`vd-ready${big ? ' big' : ''}`}>
      <video key={job.id} src={videoUrl(job.id)} controls autoPlay={big} preload="metadata" />
      <div className="vd-meta">
        <span>
          {mins(job.seconds ?? 0)} · {mb(job.bytes ?? 0)} · {job.size}p{job.chars ? ` · ${job.chars.toLocaleString()} characters voiced` : ''} · deleted in {left(job.expiresAt)} unless saved
        </span>
        <span className="spacer" />
        <a className="btn ghost" href={videoUrl(job.id, true)} download title="Save a copy anywhere: yours to keep">
          <Icon name="Download" size={12} /> Save…
        </a>
        <button className="btn ghost" title="A Slack draft carrying it (to you; choose who it's for on its card)" onClick={() => void sendVideoInSlack(job.id).then((r) => setSent(r.ok ? 'A draft is waiting on Slack’s card' : (r.error ?? 'failed')))}>
          <Icon name="Send" size={12} /> Send in Slack
        </button>
        <button className="btn ghost" title="Make another of this debrief (a different voice, slides, words…)" onClick={() => useVideos.getState().make({ sessionId: job.sessionId, debriefId: job.debriefId })}>
          <Icon name="Clapperboard" size={12} /> Make another
        </button>
        <button className="btn ghost bad" title="Delete it now" onClick={() => void deleteVideo(job.id)}>
          <Icon name="Trash2" size={12} />
        </button>
      </div>
      {sent ? <span className="vd-note">{sent}</span> : null}
    </div>
  );
}

/** The Videos panel: this session's videos, the newest playing (or where it's at), the rest a row each. */
export function VideosPanel({ sessionId }: { sessionId: string }) {
  // the store's own list (a new array from a selector would re-render forever), this session's picked out
  const all = useVideos((s) => s.jobs);
  const jobs = useMemo(() => all.filter((j) => j.sessionId === sessionId).reverse(), [all, sessionId]);
  if (!jobs.length) return <div className="vd-empty">No videos yet: ▶ Video on a debrief (Changes › Debriefs) makes one.</div>;
  const [top, ...rest] = jobs;
  return (
    <div className="vd-panel">
      <VideoBody job={top} />
      {rest.map((j) => (
        <button key={j.id} className="vd-row" onClick={() => useVideos.getState().show(j.id)}>
          <Icon name="Clapperboard" size={12} />
          <span className="t">{j.title}</span>
          <span className="m">{j.stage === 'ready' ? `${mins(j.seconds ?? 0)} · ${ago(j.createdAt)} ago` : STAGE[j.stage]}</span>
        </button>
      ))}
    </div>
  );
}
