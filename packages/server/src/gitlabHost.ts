import { DEFAULT_GITLAB_HOST } from '@cora/shared';

/**
 * The GitLab that pipelines and deploys are read from (Settings › Environments › GitLab; glab must be signed in to
 * it): gitlab.com unless the user's company runs its own. Set from settings at start and whenever they change.
 */
let host = DEFAULT_GITLAB_HOST;

export const gitlabHost = () => host;
export const setGitlabHost = (h: string | undefined) => void (host = h?.trim().toLowerCase() || DEFAULT_GITLAB_HOST);
/** Its container registry (images in deploys): registry.<host>/ */
export const registryPrefix = () => `registry.${host}/`;
/** A GitLab host as a setting: a bare host name (gitlab.com, gitlab.example.com). */
export const isGitlabHost = (h: unknown) => typeof h === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h.trim());
