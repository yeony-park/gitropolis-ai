const AUTHORIZATION_PATTERN =
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/giu;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._-]+/giu;

export function redactSecrets(
  value: string,
  secrets: readonly (string | undefined)[],
): string {
  let redacted = value;

  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }

  return redacted
    .replace(AUTHORIZATION_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]");
}
