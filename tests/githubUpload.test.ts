import { describe, expect, it } from "vitest";
import { toBase64, uploadLabels, uploadPath } from "../src/githubUpload";

describe("Markierungen zu GitHub hochladen", () => {
  it("Base64 mit Umlauten, Dateiname mit Zeitstempel", () => {
    expect(atob(toBase64("ok"))).toBe("ok");
    expect(new TextDecoder().decode(Uint8Array.from(atob(toBase64("Schwall Pianser – ü")), (c) => c.charCodeAt(0)))).toBe("Schwall Pianser – ü");
    expect(uploadPath(new Date("2026-11-26T14:05:09Z"))).toBe("daten/markierungen/markierungen-2026-11-26-140509.json");
  });

  it("PUT an die Contents-API mit Schlüssel, Fehler verständlich", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ content: { html_url: "https://github.com/x" } }), { status: 201 }); }) as unknown as typeof fetch;
    const r = await uploadLabels('{"a":1}', "tok", { fetchFn: ok, now: new Date("2026-11-26T14:05:09Z"), count: 3 });
    expect(r.url).toBe("https://github.com/x");
    expect(calls[0].url).toBe("https://api.github.com/repos/zowallawilli/App-Design-/contents/daten/markierungen/markierungen-2026-11-26-140509.json");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(calls[0].init.body as string);
    expect(atob(body.content)).toBe('{"a":1}');
    expect(body.message).toMatch(/\(3\)/);
    const fail = (s: number) => (async () => new Response("{}", { status: s })) as unknown as typeof fetch;
    await expect(uploadLabels("{}", "t", { fetchFn: fail(401) })).rejects.toThrow(/ungültig oder abgelaufen/);
    await expect(uploadLabels("{}", "t", { fetchFn: fail(403) })).rejects.toThrow(/keine Schreibrechte/);
  });
});
