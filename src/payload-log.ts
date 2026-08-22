import { createLogger, type Logger } from "./logger.ts";

/** Records an incoming webhook delivery verbatim. A no-op unless `logPayloads` is on. */
export type PayloadLogger = (label: string, payload: unknown) => void;

export function createPayloadLogger(enabled: boolean): PayloadLogger {
  if (!enabled) return () => {};
  // Its own logger at the lowest level: asking for payloads should not also
  // require lowering logLevel, which controls unrelated operational chatter.
  const log: Logger = createLogger("debug", "payload");
  return (label, payload) => log.info(`${label}\n${JSON.stringify(payload, null, 2)}`);
}
