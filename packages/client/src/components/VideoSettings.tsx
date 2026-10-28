import { useEffect, useState } from 'react';
import { DEFAULT_VIDEO, type Settings, type VideoSettings } from '@cora/shared';
import { Choice, Row, Toggle } from './settingsUi';

/**
 * Settings › Sessions › Debrief videos: the voice that
 * narrates them (Cora's own unless you pick one), its pace, their size, whether the code shows, how long they're kept.
 */
export function VideoRows({ server, save }: { server: Settings; save(p: object): Promise<string | null | void> }) {
  const v: VideoSettings = { ...DEFAULT_VIDEO, ...server.debrief?.video };
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void fetch('/api/voice/voices')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { voices?: Array<{ id: string; name: string }> } | null) => setVoices(j?.voices ?? []))
      .catch(() => {});
  }, []);
  const put = (video: Partial<VideoSettings>) => void save({ debrief: { video } });
  return (
    <>
      <Row label="Debrief videos: voice" hint="Who narrates ▶ Video on a debrief (narrated slides of it, in your Cora's look). Cora's own voice unless you pick another of your ElevenLabs voices.">
        <select value={v.voiceId} onChange={(e) => put({ voiceId: e.target.value, voiceName: voices.find((x) => x.id === e.target.value)?.name ?? '' })}>
          <option value="">Cora's voice</option>
          {voices.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
          {v.voiceId && !voices.some((x) => x.id === v.voiceId) ? <option value={v.voiceId}>{v.voiceName || v.voiceId}</option> : null}
        </select>
      </Row>
      <Row label="Debrief videos: pace and size" hint="720p makes a smaller file, easier to send.">
        <Choice value={v.speed} onChange={(speed) => put({ speed })} options={[[0.9, 'Slower'], [1, 'Normal'], [1.1, 'Faster']]} />
        <Choice value={v.size} onChange={(size) => put({ size })} options={[['1080', '1080p'], ['720', '720p']]} />
      </Row>
      <Row label="Debrief videos: kept for" hint="Unless you save a copy (Save… in the player: yours to keep), a video is deleted after this, with its slides and narration.">
        <Choice value={v.keepHours} onChange={(keepHours) => put({ keepHours })} options={[[1, 'An hour'], [24, 'A day'], [168, 'A week']]} />
      </Row>
      <Row label="Debrief videos: accent" hint="The colour of their bar, badges and lit lines.">
        <Choice value={v.accent} onChange={(accent) => put({ accent })} options={[['cora', 'Your Cora colour'], ['session', "The session's colour"]]} />
      </Row>
      <Toggle label="Debrief videos show the code" hint="Each step's lines on its slide, the ones it's about lit. Off: titles and words only, for people who don't read code." checked={v.code} onChange={(code) => put({ code })} />
      <Toggle label="Debrief videos: the orb on the title card" hint="Your Cora's orb, its ferrofluid moving, beside the title." checked={v.orb} onChange={(orb) => put({ orb })} />
      <Toggle label="Debrief videos: subtitles" hint="What's said, a line at a time, under each slide: for watching with the sound off." checked={v.subtitles} onChange={(subtitles) => put({ subtitles })} />
    </>
  );
}
