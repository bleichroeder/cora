import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { BROWSER_PROFILE_ID, HOME_PARTITION, partitionOf, type BrowserProfile, DEFAULT_GITLAB_HOST, DEFAULT_TICKET_START, TICKET_STARTS, type TicketStart, DEFAULT_MANDATE, DEFAULT_ORCHESTRATOR, DEFAULT_SETTINGS, DEFAULT_VOICE, VOICE_READS, type OrchestratorSettings, type Settings, type VoiceSettings, INSTRUCTIONS_MAX, DELIVERY_MAX, PRONOUNCE_MAX, DEFAULT_JIRA_WATCH, JIRA_ALERT_LEVELS, JIRA_EVENT_KINDS, JIRA_START_MODES, isJiraHost, type JiraAlertLevel, type JiraEventKind, type JiraWatchSettings, DEFAULT_SLACK_BOT, FINISHED_MODES, isHHMM, type SlackBotSettings, MAX_FOLLOW, MAX_FOLLOW_WORDS, type SlackFollow, WORK_SERVERS_MAX, WORK_TOOLS_MAX, type WorkServer } from '@cora/shared';
import { checkPresets } from './launch';
import { isGitlabHost } from './gitlabHost';
import { writeFileAtomic } from './fsx';

const MODES = ['off', 'markdown', 'markdown+html'] as const;
const FREQS = ['sparingly', 'normal', 'liberally'] as const;
const REPLIES = ['pointer', 'summary'] as const;

/**
 * The browser's profiles from a patch: your Chrome / Edge profiles (id and name). Each keeps the sign-ins it had (its
 * partition); a new one gets its own. One always keeps the logins Cora had before profiles: the one that has them, else
 * the one sessions use, else the first.
 */
export function browserProfiles(raw: unknown, cur: BrowserProfile[] | undefined, sessions?: string): BrowserProfile[] {
  if (!Array.isArray(raw) || raw.length > 12) throw new Error('browser.profiles must be a list of at most 12 profiles');
  const seen = new Set<string>();
  const out: BrowserProfile[] = raw.map((p: any) => {
    const id = typeof p?.id === 'string' ? p.id : '';
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!BROWSER_PROFILE_ID.test(id) || seen.has(id)) throw new Error('each browser profile needs an id like chrome:Default (once each)');
    if (!name || name.length > 60) throw new Error('each browser profile needs a name (60 characters at most)');
    seen.add(id);
    return { id, name, partition: cur?.find((c) => c.id === id)?.partition ?? partitionOf(id) };
  });
  if (out.length && !out.some((p) => p.partition === HOME_PARTITION)) {
    const home = out.find((p) => p.id === sessions) ?? out[0];
    home.partition = HOME_PARTITION;
  }
  return out;
}

type Patch = { explains?: Partial<Settings['explains']>; retentionDays?: number; presets?: unknown; voice?: Partial<VoiceSettings>; autoName?: boolean; orchestrator?: Partial<Omit<OrchestratorSettings, 'mandate'>> & { mandate?: Partial<OrchestratorSettings['mandate']> }; jira?: { watch?: Partial<Omit<JiraWatchSettings, 'kinds'>> & { kinds?: Partial<JiraWatchSettings['kinds']> }; ticket?: Partial<TicketStart> }; gitlab?: { host?: string; todos?: unknown }; slackBot?: Partial<Omit<SlackBotSettings, 'ping' | 'quiet'>> & { ping?: Partial<SlackBotSettings['ping']>; quiet?: Partial<SlackBotSettings['quiet']> }; slack?: { follow?: unknown; sign?: unknown }; browser?: { chrome?: unknown; profiles?: unknown; sessions?: unknown }; onepassword?: { on?: unknown; otp?: unknown; tools?: unknown; suggest?: unknown }; setup?: { skipped?: unknown; seen?: unknown } };

const num = (v: unknown, name: string, lo: number, hi: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`voice.${name} must be a number from ${lo} to ${hi}`);
  return n;
};

/** Validates a voice patch onto the current voice settings. */
function voicePatch(cur: VoiceSettings, v: Partial<VoiceSettings>): VoiceSettings {
  const next = { ...cur };
  if (v.enabled !== undefined) next.enabled = Boolean(v.enabled);
  if (v.voiceId !== undefined) {
    if (typeof v.voiceId !== 'string' || !/^[A-Za-z0-9]{8,40}$/.test(v.voiceId)) throw new Error('voice.voiceId must be an ElevenLabs voice ID (letters and digits)');
    next.voiceId = v.voiceId;
  }
  if (v.voiceName !== undefined) next.voiceName = String(v.voiceName).slice(0, 80);
  if (v.coraVoiceId !== undefined) {
    // empty: Cora speaks with the sessions' voice
    if (v.coraVoiceId !== '' && (typeof v.coraVoiceId !== 'string' || !/^[A-Za-z0-9]{8,40}$/.test(v.coraVoiceId))) throw new Error('voice.coraVoiceId must be an ElevenLabs voice ID (letters and digits), or empty');
    next.coraVoiceId = v.coraVoiceId;
  }
  if (v.coraVoiceName !== undefined) next.coraVoiceName = String(v.coraVoiceName).slice(0, 80);
  if (v.read !== undefined) {
    // 'auto' is what reading full replies was called before summaries existed
    const read = (v.read as string) === 'auto' ? 'full' : v.read;
    if (!VOICE_READS.includes(read)) throw new Error(`voice.read must be one of ${VOICE_READS.join(', ')}`);
    next.read = read;
  }
  if (v.after !== undefined) {
    if (v.after !== 'review' && v.after !== 'send') throw new Error('voice.after must be review or send');
    next.after = v.after;
  }
  if (v.coraAfter !== undefined) {
    if (v.coraAfter !== 'review' && v.coraAfter !== 'send') throw new Error('voice.coraAfter must be review or send');
    next.coraAfter = v.coraAfter;
  }
  if (v.wake !== undefined) {
    if (typeof v.wake !== 'boolean') throw new Error('voice.wake must be true or false');
    next.wake = v.wake;
  }
  if (v.wakeSensitivity !== undefined) {
    if (!['low', 'balanced', 'high'].includes(v.wakeSensitivity)) throw new Error('voice.wakeSensitivity must be low, balanced or high');
    next.wakeSensitivity = v.wakeSensitivity;
  }
  if (v.wakeFollowUp !== undefined) {
    if (typeof v.wakeFollowUp !== 'boolean') throw new Error('voice.wakeFollowUp must be true or false');
    next.wakeFollowUp = v.wakeFollowUp;
  }
  if (v.front !== undefined) {
    if (typeof v.front !== 'boolean') throw new Error('voice.front must be true or false');
    next.front = v.front;
  }
  if (v.endOnSilence !== undefined) next.endOnSilence = Math.round(num(v.endOnSilence, 'endOnSilence', 0, 5000));
  if (v.announce !== undefined) next.announce = Boolean(v.announce);
  if (v.announceTasks !== undefined) next.announceTasks = Boolean(v.announceTasks);
  if (v.announceFailures !== undefined) next.announceFailures = Boolean(v.announceFailures);
  if (v.announcePipelines !== undefined) next.announcePipelines = Boolean(v.announcePipelines);
  if (v.cap !== undefined) next.cap = Math.round(num(v.cap, 'cap', 100, 5000));
  if (v.stability !== undefined) next.stability = num(v.stability, 'stability', 0, 1);
  if (v.speed !== undefined) next.speed = num(v.speed, 'speed', 0.7, 1.2);
  if (v.model !== undefined) {
    if (typeof v.model !== 'string' || !/^eleven_[a-z0-9_]{1,40}$/.test(v.model)) throw new Error('voice.model must be an ElevenLabs model ID (eleven_…)');
    next.model = v.model;
  }
  for (const k of ['delivery', 'coraDelivery'] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== 'string' || v[k]!.length > DELIVERY_MAX) throw new Error(`voice.${k} must be text, ${DELIVERY_MAX} characters at most`);
    next[k] = v[k]!.trim();
  }
  if (v.style !== undefined) next.style = num(v.style, 'style', 0, 1);
  if (v.pronounce !== undefined) {
    const list = v.pronounce as unknown;
    if (!Array.isArray(list) || list.length > PRONOUNCE_MAX) throw new Error(`voice.pronounce must be a list of at most ${PRONOUNCE_MAX} swaps`);
    next.pronounce = list.map((x: any) => {
      const from = typeof x?.from === 'string' ? x.from.trim() : '';
      const to = typeof x?.to === 'string' ? x.to.trim() : '';
      if (!from || from.length > 60 || to.length > 120) throw new Error('voice.pronounce: each swap is a word or phrase (60 characters at most) and how to say it (120 at most)');
      return { from, to };
    });
  }
  return next;
}

/**
 * Voice settings saved by an older Cora: background tasks used to be announced with permission prompts, so they
 * keep following that choice until set on their own ('auto' reading is mapped in voicePatch).
 */
export function migrateVoice(saved: Partial<VoiceSettings> | undefined): Partial<VoiceSettings> | undefined {
  if (!saved || typeof saved !== 'object') return saved;
  return saved.announceTasks === undefined && saved.announce !== undefined ? { ...saved, announceTasks: Boolean(saved.announce) } : saved;
}

/** Validates a settings patch; throws with a user-facing message on bad values. */
export function applyPatch(cur: Settings, patch: Patch): Settings {
  const next: Settings = { explains: { ...cur.explains }, retentionDays: cur.retentionDays, presets: cur.presets ?? [], voice: { ...DEFAULT_VOICE, ...cur.voice }, autoName: cur.autoName ?? false, orchestrator: { ...DEFAULT_ORCHESTRATOR, ...cur.orchestrator, mandate: { ...DEFAULT_MANDATE, ...cur.orchestrator?.mandate } }, jira: { watch: { ...DEFAULT_JIRA_WATCH, ...cur.jira?.watch, kinds: { ...DEFAULT_JIRA_WATCH.kinds, ...cur.jira?.watch?.kinds } }, ticket: { ...DEFAULT_TICKET_START, ...cur.jira?.ticket } }, gitlab: { host: cur.gitlab?.host || DEFAULT_GITLAB_HOST, todos: cur.gitlab?.todos ?? true }, slackBot: { ...DEFAULT_SLACK_BOT, ...cur.slackBot, ping: { ...DEFAULT_SLACK_BOT.ping, ...cur.slackBot?.ping }, quiet: { ...DEFAULT_SLACK_BOT.quiet, ...cur.slackBot?.quiet } }, slack: { follow: cur.slack?.follow ?? [], sign: cur.slack?.sign ?? ':cora:' }, browser: { chrome: cur.browser?.chrome ?? true, ...(cur.browser?.profiles?.length ? { profiles: cur.browser.profiles } : {}), ...(cur.browser?.sessions ? { sessions: cur.browser.sessions } : {}) }, onepassword: { on: cur.onepassword?.on ?? true, otp: cur.onepassword?.otp ?? true, tools: cur.onepassword?.tools ?? true, suggest: cur.onepassword?.suggest ?? true }, setup: { skipped: cur.setup?.skipped ?? [], seen: cur.setup?.seen ?? false } };
  const e = patch.explains ?? {};
  if (e.mode !== undefined) {
    if (!MODES.includes(e.mode as any)) throw new Error(`explains.mode must be one of ${MODES.join(', ')}`);
    next.explains.mode = e.mode;
  }
  if (e.frequency !== undefined) {
    if (!FREQS.includes(e.frequency as any)) throw new Error(`explains.frequency must be one of ${FREQS.join(', ')}`);
    next.explains.frequency = e.frequency;
  }
  if (e.reply !== undefined) {
    if (!REPLIES.includes(e.reply as any)) throw new Error(`explains.reply must be one of ${REPLIES.join(', ')}`);
    next.explains.reply = e.reply;
  }
  if (patch.presets !== undefined) next.presets = checkPresets(patch.presets);
  if (patch.voice !== undefined) next.voice = voicePatch(next.voice, patch.voice ?? {});
  if (patch.retentionDays !== undefined) {
    const d = Number(patch.retentionDays);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('retentionDays must be a whole number from 1 to 365');
    next.retentionDays = d;
  }
  if (patch.autoName !== undefined) {
    if (typeof patch.autoName !== 'boolean') throw new Error('autoName must be true or false');
    next.autoName = patch.autoName;
  }
  const o = patch.orchestrator;
  if (o !== undefined) {
    if (o.enabled !== undefined) {
      if (typeof o.enabled !== 'boolean') throw new Error('orchestrator.enabled must be true or false');
      next.orchestrator.enabled = o.enabled;
    }
    if (o.speak !== undefined) {
      if (typeof o.speak !== 'boolean') throw new Error('orchestrator.speak must be true or false');
      next.orchestrator.speak = o.speak;
    }
    if (o.instructions !== undefined) {
      if (typeof o.instructions !== 'string') throw new Error('orchestrator.instructions must be text');
      if (o.instructions.length > INSTRUCTIONS_MAX) throw new Error(`orchestrator.instructions: ${INSTRUCTIONS_MAX} characters at most`);
      next.orchestrator.instructions = o.instructions.trim();
    }
    if (o.workServers !== undefined) next.orchestrator.workServers = checkWorkServers(o.workServers);
    if (o.model !== undefined) {
      // it becomes a claude argument: a model name or alias, nothing else
      if (typeof o.model !== 'string' || !/^[\w.[\]-]{2,60}$/.test(o.model)) throw new Error('orchestrator.model must be a model name like opus or claude-opus-5-5');
      next.orchestrator.model = o.model;
    }
    if (o.budget !== undefined) {
      const b = Number(o.budget);
      if (!Number.isFinite(b) || b < 100_000 || b > 100_000_000) throw new Error('orchestrator.budget must be from 100,000 to 100,000,000 tokens');
      next.orchestrator.budget = Math.round(b);
    }
    if (o.events !== undefined) {
      if (o.events !== 'important' && o.events !== 'off') throw new Error('orchestrator.events must be important or off');
      next.orchestrator.events = o.events;
    }
    if (o.briefs !== undefined) {
      if (o.briefs !== 'welcome' && o.briefs !== 'off') throw new Error('orchestrator.briefs must be welcome or off');
      next.orchestrator.briefs = o.briefs;
    }
    const m = o.mandate;
    if (m !== undefined) {
      const mandate = { ...next.orchestrator.mandate };
      if (m.repos !== undefined) {
        if (!Array.isArray(m.repos) || m.repos.length > 30) throw new Error('orchestrator.mandate.repos must be a list of at most 30 folders');
        for (const r of m.repos) if (typeof r !== 'string' || !isAbsolute(r) || r.length > 400) throw new Error(`orchestrator.mandate.repos: "${r}" must be an absolute folder path`);
        mandate.repos = [...new Set(m.repos.map((r) => r.replace(/[\\/]+$/, '')))];
      }
      if (m.deploy !== undefined) {
        if (typeof m.deploy !== 'boolean') throw new Error('orchestrator.mandate.deploy must be true or false');
        mandate.deploy = m.deploy;
      }
      if (m.slack !== undefined) {
        if (!Array.isArray(m.slack) || m.slack.length > 50 || !m.slack.every((c) => typeof c === 'string' && /^#?[\w.-]{1,80}$/.test(c))) throw new Error('orchestrator.mandate.slack must be a list of channel names');
        mandate.slack = m.slack.map((c) => c.replace(/^#/, ''));
      }
      next.orchestrator.mandate = mandate;
    }
  }
  // the GitLab pipelines and deploys are read from (glab's host)
  if (patch.gitlab?.host !== undefined) {
    const h = typeof patch.gitlab.host === 'string' ? patch.gitlab.host.trim().toLowerCase() : '';
    if (!isGitlabHost(h)) throw new Error('gitlab.host must be a host name, like gitlab.com or gitlab.example.com');
    next.gitlab.host = h;
  }
  if (patch.gitlab?.todos !== undefined) {
    if (typeof patch.gitlab.todos !== 'boolean') throw new Error('gitlab.todos must be true or false');
    next.gitlab.todos = patch.gitlab.todos;
  }
  // how ticket sessions start: the user's own /jira (auto, when they have one), Cora's prompt, or a command of theirs
  const tk = patch.jira?.ticket;
  if (tk !== undefined) {
    if (tk.with !== undefined) {
      if (!(TICKET_STARTS as readonly string[]).includes(tk.with)) throw new Error(`jira.ticket.with must be one of ${TICKET_STARTS.join(', ')}`);
      next.jira.ticket.with = tk.with;
    }
    if (tk.command !== undefined) {
      const c = typeof tk.command === 'string' ? tk.command.trim() : '';
      if (!/^\/?[\w:.-]{1,60}$/.test(c)) throw new Error('jira.ticket.command must be a slash command, like /jira');
      next.jira.ticket.command = c.startsWith('/') ? c : `/${c}`;
    }
  }
  const jw = patch.jira?.watch;
  if (jw !== undefined) {
    if (jw.on !== undefined) {
      if (typeof jw.on !== 'boolean') throw new Error('jira.watch.on must be true or false');
      next.jira.watch.on = jw.on;
    }
    if (jw.site !== undefined) {
      if (jw.site !== '' && (typeof jw.site !== 'string' || !isJiraHost(jw.site))) throw new Error('jira.watch.site must be a Jira host like you.atlassian.net');
      if (jw.site) next.jira.watch.site = jw.site;
      else delete next.jira.watch.site;
    }
    if (jw.start !== undefined) {
      if (!(JIRA_START_MODES as readonly string[]).includes(jw.start)) throw new Error(`jira.watch.start must be one of ${JIRA_START_MODES.join(', ')}`);
      next.jira.watch.start = jw.start;
    }
    for (const [k, v] of Object.entries(jw.kinds ?? {})) {
      if (!(JIRA_EVENT_KINDS as readonly string[]).includes(k) || !JIRA_ALERT_LEVELS.includes(v as JiraAlertLevel)) throw new Error(`jira.watch.kinds: ${k} must be one of ${JIRA_ALERT_LEVELS.join(', ')}`);
      next.jira.watch.kinds[k as JiraEventKind] = v as JiraAlertLevel;
    }
  }
  const sb = patch.slackBot;
  if (sb !== undefined) {
    if (typeof sb !== 'object' || sb === null) throw new Error('slackBot must be an object');
    const bool = (v: unknown, name: string) => {
      if (typeof v !== 'boolean') throw new Error(`slackBot.${name} must be true or false`);
      return v;
    };
    if (sb.alerts !== undefined) next.slackBot.alerts = bool(sb.alerts, 'alerts');
    if (sb.instructions !== undefined) next.slackBot.instructions = bool(sb.instructions, 'instructions');
    if (sb.awayMinutes !== undefined) {
      if (!Number.isInteger(sb.awayMinutes) || sb.awayMinutes < 1 || sb.awayMinutes > 240) throw new Error('slackBot.awayMinutes must be 1 to 240');
      next.slackBot.awayMinutes = sb.awayMinutes;
    }
    if (sb.dailyCap !== undefined) {
      if (!Number.isInteger(sb.dailyCap) || sb.dailyCap < 1 || sb.dailyCap > 500) throw new Error('slackBot.dailyCap must be 1 to 500');
      next.slackBot.dailyCap = sb.dailyCap;
    }
    if (sb.finished !== undefined) {
      if (!(FINISHED_MODES as readonly string[]).includes(sb.finished)) throw new Error(`slackBot.finished must be one of ${FINISHED_MODES.join(', ')}`);
      next.slackBot.finished = sb.finished;
    }
    for (const k of ['prompts', 'failures', 'tickets', 'mail'] as const) if (sb.ping?.[k] !== undefined) next.slackBot.ping[k] = bool(sb.ping[k], `ping.${k}`);
    if (sb.quiet?.on !== undefined) next.slackBot.quiet.on = bool(sb.quiet.on, 'quiet.on');
    for (const k of ['from', 'to'] as const) {
      const v = sb.quiet?.[k];
      if (v === undefined) continue;
      if (!isHHMM(v)) throw new Error(`slackBot.quiet.${k} must be HH:MM`);
      next.slackBot.quiet[k] = v;
    }
  }
  if (patch.slack?.follow !== undefined) next.slack = { ...next.slack, follow: checkFollow(patch.slack.follow) };
  // 1Password in Cora's browser
  for (const k of ['on', 'otp', 'tools', 'suggest'] as const) {
    const v = patch.onepassword?.[k];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new Error(`onepassword.${k} must be true or false`);
    next.onepassword = { ...next.onepassword, [k]: v };
  }
  if (patch.browser?.chrome !== undefined) {
    if (typeof patch.browser.chrome !== 'boolean') throw new Error('browser.chrome must be true or false');
    next.browser = { ...next.browser, chrome: patch.browser.chrome };
  }
  // the browser's profiles (your Chrome / Edge ones you brought in), and the one sessions use
  if (patch.browser?.profiles !== undefined || patch.browser?.sessions !== undefined) {
    const sessions = patch.browser.sessions !== undefined ? patch.browser.sessions : next.browser.sessions;
    if (sessions !== undefined && sessions !== null && typeof sessions !== 'string') throw new Error('browser.sessions must be a profile id');
    const profiles = patch.browser.profiles !== undefined ? browserProfiles(patch.browser.profiles, next.browser.profiles, sessions || undefined) : (next.browser.profiles ?? []);
    const kept = !!sessions && profiles.some((p) => p.id === sessions);
    // asked for one that isn't there: refused; the one it was, gone with its profile: sessions go back to the default
    if (sessions && !kept && patch.browser.sessions !== undefined) throw new Error('browser.sessions must be one of the profiles');
    const { profiles: _p, sessions: _s, ...rest } = next.browser;
    next.browser = { ...rest, ...(profiles.length ? { profiles } : {}), ...(kept ? { sessions } : {}) };
  }
  // the sign-off on what Cora sends for you: an emoji (:name:) or a few words, or nothing
  if (patch.slack?.sign !== undefined) {
    const sign = typeof patch.slack.sign === 'string' ? patch.slack.sign.trim() : null;
    if (sign == null || sign.length > 40 || /[\n<>]/.test(sign)) throw new Error('slack.sign must be an emoji like :cora: or a few words (40 characters at most), or empty');
    next.slack = { ...next.slack, sign };
  }
  const su = patch.setup;
  if (su !== undefined) {
    if (typeof su !== 'object' || su === null) throw new Error('setup must be an object');
    if (su.skipped !== undefined) {
      if (!Array.isArray(su.skipped) || su.skipped.length > 40 || !su.skipped.every((x) => typeof x === 'string' && /^[\w-]{1,40}$/.test(x))) throw new Error('setup.skipped must be a list of feature ids');
      next.setup.skipped = [...new Set(su.skipped as string[])];
    }
    if (su.seen !== undefined) {
      if (typeof su.seen !== 'boolean') throw new Error('setup.seen must be true or false');
      next.setup.seen = su.seen;
    }
  }
  return next;
}

/** Channels you follow: their ids and names, and your words for each (trimmed, lower-case, no repeats). */
function checkFollow(v: unknown): SlackFollow[] {
  if (!Array.isArray(v) || v.length > MAX_FOLLOW) throw new Error(`slack.follow must be a list of at most ${MAX_FOLLOW} channels`);
  const seen = new Set<string>();
  return v.map((f) => {
    if (typeof f !== 'object' || f === null) throw new Error('slack.follow: each channel is { id, label, words }');
    const { id, label, words } = f as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[CG][A-Z0-9]{6,}$/.test(id) || seen.has(id)) throw new Error('slack.follow: a channel id (C… or G…), once each');
    seen.add(id);
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error('slack.follow: a label of up to 80 characters');
    if (!Array.isArray(words) || words.length > MAX_FOLLOW_WORDS || !words.every((w) => typeof w === 'string' && w.trim().length >= 2 && w.trim().length <= 40)) throw new Error(`slack.follow: at most ${MAX_FOLLOW_WORDS} words of 2 to 40 characters`);
    return { id, label: label.trim(), words: [...new Set((words as string[]).map((w) => w.trim().toLowerCase()))] };
  });
}

/** User settings, persisted in config.json alongside any other keys there. */
export class Prefs {
  private cur: Settings;

  /** what couldn't be read from config.json (each kept aside, never written over) */
  readonly problems: string[] = [];
  /** config.json is from a Cora (0.1.0) with a workplace preset: the server keeps its cluster labels, once */
  readonly hadPreset: string | null = null;

  constructor(private file: string | null) {
    let fromFile: Patch = {};
    try {
      if (file && existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      // not JSON any more: kept beside it as it was, so the next save can't lose it (docs/audit-2026-10-20.md B1)
      this.keepAside(`config.json isn't valid JSON (${(e as Error).message})`);
    }
    // 0.1.0's workplace preset (its labels are kept: see hadPreset; Deploys finds a project's prefix on its own)
    const old = (fromFile as { preset?: unknown }).preset;
    if (typeof old === 'string' && old !== 'none') this.hadPreset = old;
    const parts: Patch = { explains: fromFile.explains, retentionDays: fromFile.retentionDays, presets: fromFile.presets, voice: migrateVoice(fromFile.voice), autoName: fromFile.autoName, orchestrator: fromFile.orchestrator, jira: fromFile.jira, slackBot: fromFile.slackBot, slack: fromFile.slack, browser: fromFile.browser, onepassword: fromFile.onepassword, setup: fromFile.setup, gitlab: fromFile.gitlab };
    try {
      this.cur = applyPatch(DEFAULT_SETTINGS, parts);
    } catch {
      // one bad value: every section that's fine is kept; only the bad one falls back (and the file is kept aside)
      let cur = structuredClone(DEFAULT_SETTINGS);
      const bad: string[] = [];
      for (const [k, v] of Object.entries(parts)) {
        if (v === undefined) continue;
        try {
          cur = applyPatch(cur, { [k]: v } as Patch);
        } catch (e) {
          bad.push(`${k}: ${(e as Error).message}`);
        }
      }
      this.cur = cur;
      this.keepAside(`config.json has settings Cora can't use (${bad.join('; ')})`);
    }
  }

  /** A copy of config.json as it is, beside it, once; and why. */
  private keepAside(why: string): void {
    this.problems.push(why);
    console.warn(`[cora] ${why}`);
    if (!this.file || !existsSync(this.file) || this.problems.length > 1) return;
    try {
      const copy = `${this.file}.kept-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(this.file, copy);
      console.warn(`[cora] a copy of it as it was: ${copy}`);
    } catch {
      /* best effort */
    }
  }

  get(): Settings {
    return this.cur;
  }

  update(patch: Patch): Settings {
    this.cur = applyPatch(this.cur, patch);
    if (this.file) {
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(readFileSync(this.file, 'utf8'));
      } catch {
        /* new file */
      }
      delete raw.preset;
      delete raw.deploys;
      writeFileAtomic(this.file, JSON.stringify({ ...raw, explains: this.cur.explains, retentionDays: this.cur.retentionDays, presets: this.cur.presets, voice: this.cur.voice, autoName: this.cur.autoName, orchestrator: this.cur.orchestrator, jira: this.cur.jira, slackBot: this.cur.slackBot, slack: this.cur.slack, browser: this.cur.browser, onepassword: this.cur.onepassword, setup: this.cur.setup, gitlab: this.cur.gitlab }, null, 2) + '\n');
    }
    return this.cur;
  }
}

/**
 * Your work MCP servers for Cora: their names and tools become Claude Code tool names Cora may use without asking, so
 * only names Claude Code's could be; what each is for, a line of text.
 */
function checkWorkServers(v: unknown): Record<string, WorkServer> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('orchestrator.workServers must be a list of servers');
  const all = Object.entries(v as Record<string, unknown>);
  if (all.length > WORK_SERVERS_MAX) throw new Error(`orchestrator.workServers: ${WORK_SERVERS_MAX} at most`);
  const out: Record<string, WorkServer> = {};
  for (const [name, w] of all) {
    if (!/^[\w.-]{1,64}$/.test(name)) throw new Error(`orchestrator.workServers: "${name.slice(0, 40)}" isn't an MCP server name`);
    const about = (w as { about?: unknown })?.about;
    const read = (w as { read?: unknown })?.read;
    if (typeof about !== 'string' || about.length > 200) throw new Error(`orchestrator.workServers.${name}: say what it's for (200 characters at most)`);
    if (!Array.isArray(read) || read.length > WORK_TOOLS_MAX || !read.every((t) => typeof t === 'string' && /^[\w.-]{1,100}$/.test(t))) throw new Error(`orchestrator.workServers.${name}: its read-only tools, by name (${WORK_TOOLS_MAX} at most)`);
    out[name] = { about: about.trim() || name, read: [...new Set(read as string[])] };
  }
  return out;
}
