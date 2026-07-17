export function isInternalNavigation(appUrl: string, candidate: string): boolean {
  try {
    const app = new URL(appUrl);
    const target = new URL(candidate);
    return app.protocol === "http:" && target.origin === app.origin;
  } catch {
    return false;
  }
}

export function safeExternalUrl(candidate: string): URL | undefined {
  try {
    const target = new URL(candidate);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username !== "" ||
      target.password !== ""
    ) {
      return undefined;
    }
    return target;
  } catch {
    return undefined;
  }
}
