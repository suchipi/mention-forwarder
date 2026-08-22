import type { Delivery } from "./types.ts";

/** Posts one signed webhook at the forwarder and reports what came back, including a connection failure. */
export async function deliver(url: string, body: string, headers: Record<string, string>): Promise<Delivery> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    const text = (await response.text()).trim();
    return { ok: response.ok, status: response.status, detail: text.slice(0, 400) };
  } catch (error) {
    return { ok: false, status: null, detail: (error as Error).message };
  }
}
