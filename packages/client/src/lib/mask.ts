const DOTS = '••••••';

const RULES: Array<[RegExp, (m: string, ...g: string[]) => string]> = [
  // Authorization: Bearer xxx / Basic xxx
  [/(Authorization:\s*(?:Bearer|Basic|token)?\s*)([^\s'"]{6,})/gi, (_m, pre) => pre + DOTS],
  // bare "Bearer xxx"
  [/(\bBearer\s+)([A-Za-z0-9._\-~+/]{8,}=*)/g, (_m, pre) => pre + DOTS],
  // NAME_TOKEN=value, api_key: "value", password=value
  [/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*["']?\s*[=:]\s*)(["']?)([^\s"']{4,})\2/gi, (_m, pre, q) => `${pre}${q}${DOTS}${q}`],
  // AWS access key ids
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => DOTS],
  // Anthropic / OpenAI style keys, GitHub tokens, Slack tokens
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, () => DOTS],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, () => DOTS],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, () => DOTS],
];

/** Mask values that look like secrets. Display-only: stored data is untouched. */
export function maskSecrets(input: string): { text: string; masked: boolean } {
  let text = input;
  for (const [re, fn] of RULES) text = text.replace(re, fn as any);
  return { text, masked: text !== input };
}
