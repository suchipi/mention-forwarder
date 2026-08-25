import { lookup } from "node:dns/promises";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import type { RequestHandler } from "express";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Platform } from "./types.ts";

/**
 * GitHub's webhook source ranges as of the last time this file was touched. Only
 * a starting point: the live list comes from the API, and GitHub rotates it.
 */
const GITHUB_FALLBACK_HOOKS = [
  "192.30.252.0/22",
  "185.199.108.0/22",
  "140.82.112.0/20",
  "143.55.64.0/20",
  "2a0a:a440::/29",
  "2606:50c0::/32",
];

/** Linear publishes fixed addresses rather than an endpoint to read them from. */
const LINEAR_HOOKS = [
  "35.231.147.226",
  "35.243.134.228",
  "35.196.141.51",
  "34.140.253.14",
  "34.38.87.206",
  "34.62.119.29",
  "34.134.222.122",
  "35.222.25.142",
  "34.60.255.158",
];

/**
 * Stands in for the platform's own list inside `allowedSources`, so adding one
 * address does not mean pinning the rest. Keeping it in GitHub's list is also
 * what leaves the daily refresh running, so a rotated range still arrives.
 */
const DEFAULT_MARKER = "...default";

const PUBLIC_GITHUB_API = "https://api.github.com";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Refuses a request whose body is larger than `maxBytes`, before anything reads it.
 *
 * All three webhook libraries buffer the entire body and only then check the
 * signature, so without this an unsigned request can spend the process's memory
 * for it. A body of unknown length is refused outright: every platform sends a
 * `Content-Length`, and honouring a chunked upload would mean streaming an
 * unbounded body to find out how big it was.
 *
 * @param maxBytes Largest body to accept, in bytes.
 * @param log Where refusals are reported.
 */
export function createSizeGate(maxBytes: number, log: Logger): RequestHandler {
  return (request, response, next) => {
    const header = request.headers["content-length"];
    const length = typeof header === "string" ? Number(header) : Number.NaN;

    if (!Number.isSafeInteger(length) || length < 0) {
      log.warn("refused a webhook with no usable Content-Length", { path: request.originalUrl });
      response.status(411).type("text/plain").send("Length Required\n");
      return;
    }
    if (length > maxBytes) {
      log.warn("refused an oversized webhook", { path: request.originalUrl, bytes: length, maxBytes });
      response.status(413).type("text/plain").send("Payload Too Large\n");
      return;
    }
    next();
  };
}

export type SourceGuard = {
  /** Rejects a request whose origin is not one this platform is expected to call from. */
  middlewareFor(platform: Platform): RequestHandler;
  /** Reports what each platform will accept, for the startup summary. */
  describe(platform: Platform): string;
  close(): void;
};

type Allowed = { list: BlockList; restricted: boolean; sources: string[] };

/**
 * Builds the per-platform source allowlists and keeps GitHub's up to date.
 *
 * Loopback is always allowed, which is what a tunnel or a local simulator comes
 * in on. Beyond that each platform gets the addresses it actually calls from:
 * GitHub's read from its own API, Linear's published list, and for Slack nothing,
 * because Slack runs on AWS and publishes no ranges, leaving its signature as the
 * only control. `allowedSources` in the config replaces whichever list applies,
 * except where it contains `...default`, which expands to that list in place.
 *
 * The refresh runs in the background: the process starts on the bundled values
 * rather than waiting on a network call that may not answer.
 */
export function createSourceGuard(config: Config, log: Logger): SourceGuard {
  const allowed = new Map<Platform, Allowed>();
  // Kept unexpanded so a GitHub refresh can re-render it against the fetched
  // ranges rather than accumulating every list ever seen.
  const templates = new Map<Platform, string[]>();

  for (const platform of ["github", "slack", "linear"] as const) {
    const settings = config[platform];
    if (settings === undefined) continue;
    const template = settings.allowedSources ?? [DEFAULT_MARKER];
    templates.set(platform, template);
    allowed.set(platform, build(expand(template, defaultSources(platform)), platform, log));
    if (platform === "github" && template.includes(DEFAULT_MARKER)) {
      void refreshGitHub(config, templates, allowed, log);
    }
    void addApiHost(settings.apiUrl, platform, allowed, log);
  }

  const timer = setInterval(() => {
    if (templates.get("github")?.includes(DEFAULT_MARKER) === true && allowed.has("github")) {
      void refreshGitHub(config, templates, allowed, log);
    }
  }, REFRESH_INTERVAL_MS);
  timer.unref();

  return {
    middlewareFor(platform) {
      return (request, response, next) => {
        const entry = allowed.get(platform);
        if (entry === undefined || !entry.restricted) return next();

        const client = normalize(request.ip);
        if (client === undefined) {
          log.warn("refused a webhook from an unreadable address", { platform, ip: request.ip });
          response.status(403).type("text/plain").send("Forbidden\n");
          return;
        }
        if (!entry.list.check(client.address, client.type)) {
          log.warn("refused a webhook from an unexpected address", { platform, ip: client.address });
          response.status(403).type("text/plain").send("Forbidden\n");
          return;
        }
        next();
      };
    },

    describe(platform) {
      const entry = allowed.get(platform);
      if (entry === undefined || !entry.restricted) return "any source (signature only)";
      return `${entry.sources.length} allowed source${entry.sources.length === 1 ? "" : "s"}, plus loopback`;
    },

    close() {
      clearInterval(timer);
    },
  };
}

function defaultSources(platform: Platform): string[] {
  if (platform === "github") return GITHUB_FALLBACK_HOOKS;
  if (platform === "linear") return LINEAR_HOOKS;
  return [];
}

/** Replaces every `...default` with `defaults`, keeping the first copy of a repeated entry. */
function expand(template: string[], defaults: string[]): string[] {
  const out: string[] = [];
  for (const entry of template) {
    for (const source of entry === DEFAULT_MARKER ? defaults : [entry]) {
      if (!out.includes(source)) out.push(source);
    }
  }
  return out;
}

function build(sources: string[], platform: Platform, log: Logger): Allowed {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");

  const accepted: string[] = [];
  for (const source of sources) {
    if (add(list, source)) accepted.push(source);
    else log.warn("ignoring an unreadable entry in allowedSources", { platform, source });
  }
  return { list, restricted: accepted.length > 0, sources: accepted };
}

function add(list: BlockList, source: string): boolean {
  const [address, prefix] = source.split("/");
  if (address === undefined) return false;

  const type = isIPv4(address) ? "ipv4" : isIPv6(address) ? "ipv6" : undefined;
  if (type === undefined) return false;

  if (prefix === undefined) {
    list.addAddress(address, type);
    return true;
  }
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > (type === "ipv4" ? 32 : 128)) return false;
  list.addSubnet(address, bits, type);
  return true;
}

/** An IPv4-mapped address arrives as `::ffff:1.2.3.4`, which no IPv4 rule would match. */
function normalize(ip: string | undefined): { address: string; type: "ipv4" | "ipv6" } | undefined {
  if (ip === undefined) return undefined;
  const bare = ip.replace(/%.*$/, "");
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(bare)?.[1];
  const address = mapped ?? bare;
  if (isIPv4(address)) return { address, type: "ipv4" };
  if (isIPv6(address)) return { address, type: "ipv6" };
  return undefined;
}

async function refreshGitHub(
  config: Config,
  templates: Map<Platform, string[]>,
  allowed: Map<Platform, Allowed>,
  log: Logger,
): Promise<void> {
  const base = (config.github?.apiUrl ?? PUBLIC_GITHUB_API).replace(/\/$/, "");
  // A stub or a tunnelled instance answers on loopback, which is already allowed
  // and has no /meta worth asking for.
  if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(base)) return;

  try {
    const response = await fetch(`${base}/meta`, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = (await response.json()) as { hooks?: unknown };
    const hooks = Array.isArray(body.hooks) ? body.hooks.filter((entry) => typeof entry === "string") : [];
    if (hooks.length === 0) throw new Error("no hook ranges in the response");

    const previous = allowed.get("github");
    const rebuilt = build(expand(templates.get("github") ?? [DEFAULT_MARKER], hooks), "github", log);
    for (const source of previous?.sources ?? []) {
      if (!rebuilt.sources.includes(source) && add(rebuilt.list, source)) rebuilt.sources.push(source);
    }
    allowed.set("github", rebuilt);
    log.info("refreshed GitHub's webhook source ranges", { from: `${base}/meta`, ranges: hooks.length });
  } catch (error) {
    log.warn("could not refresh GitHub's webhook source ranges; keeping the ones already loaded", {
      error: (error as Error).message,
    });
  }
}

/** The platform's own API host, which is where a stub or a self-hosted instance calls from. */
async function addApiHost(
  apiUrl: string | undefined,
  platform: Platform,
  allowed: Map<Platform, Allowed>,
  log: Logger,
): Promise<void> {
  if (apiUrl === undefined) return;
  let host: string;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    return;
  }

  try {
    const results = await lookup(host, { all: true });
    const entry = allowed.get(platform);
    if (entry === undefined) return;
    for (const { address } of results) {
      const known = normalize(address);
      if (known !== undefined && entry.list.check(known.address, known.type)) continue;
      if (!entry.sources.includes(address) && add(entry.list, address)) entry.sources.push(address);
    }
    if (entry.restricted) log.debug("allowing the configured API host as a source", { platform, host });
  } catch (error) {
    log.warn("could not resolve the configured apiUrl host", { platform, host, error: (error as Error).message });
  }
}
