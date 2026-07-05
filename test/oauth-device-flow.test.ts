// Real HTTP calls (fetch) against a fake local server standing in for the
// OAuth provider — same fixture philosophy as the fake ACP agent: genuinely
// exercises the wire shape (RFC 8628 device flow), not a mock of `fetch`.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeviceFlowDeniedError,
  DeviceFlowExpiredError,
  pollForToken,
  refreshToken,
  requestDeviceCode,
  type DeviceFlowEndpoints,
} from "../src/orchestrator/oauth-device-flow";

async function readBody(req: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

interface Script {
  device?: { user_code: string; device_code: string; verification_uri: string; expires_in: number; interval: number };
  /** Sequence of token-endpoint responses, one per poll/refresh call. */
  tokenResponses: Record<string, unknown>[];
}

function startFakeProvider(script: Script): { server: Server; endpoints(clientId?: string): DeviceFlowEndpoints; close(): Promise<void> } {
  let tokenCallIndex = 0;
  const server = createServer((req, res) => {
    void (async () => {
      await readBody(req);
      res.setHeader("content-type", "application/json");
      if (req.url === "/device/code") {
        const d = script.device ?? {
          user_code: "ABCD-1234",
          device_code: "dev-abc",
          verification_uri: "https://example.test/activate",
          expires_in: 2,
          interval: 0,
        };
        res.end(JSON.stringify(d));
        return;
      }
      const body = script.tokenResponses[Math.min(tokenCallIndex, script.tokenResponses.length - 1)];
      tokenCallIndex++;
      res.end(JSON.stringify(body));
    })();
  });
  return {
    server,
    endpoints: (clientId = "client-1") => ({
      deviceCodeUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/device/code`,
      tokenUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/token`,
      clientId,
      scopes: ["repo"],
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let provider: ReturnType<typeof startFakeProvider> | null = null;
beforeEach(() => {
  provider = null;
});
afterEach(async () => {
  await provider?.close();
});

describe("OAuth Device Flow", () => {
  it("requests a device code and parses the response", async () => {
    provider = startFakeProvider({ tokenResponses: [] });
    await new Promise<void>((r) => provider!.server.listen(0, r));
    const device = await requestDeviceCode(provider.endpoints());
    expect(device.userCode).toBe("ABCD-1234");
    expect(device.verificationUri).toBe("https://example.test/activate");
  });

  it("polls through authorization_pending before succeeding", async () => {
    provider = startFakeProvider({
      tokenResponses: [
        { error: "authorization_pending" },
        { error: "authorization_pending" },
        { access_token: "tok-1", refresh_token: "refresh-1", expires_in: 3600 },
      ],
    });
    await new Promise<void>((r) => provider!.server.listen(0, r));
    const endpoints = provider.endpoints();
    const device = await requestDeviceCode(endpoints);
    const result = await pollForToken(endpoints, { ...device, interval: 0 });
    expect(result.accessToken).toBe("tok-1");
    expect(result.refreshToken).toBe("refresh-1");
  });

  it("slow_down backs off the poll interval rather than hammering the provider", async () => {
    provider = startFakeProvider({
      device: {
        user_code: "X",
        device_code: "d",
        verification_uri: "https://example.test",
        expires_in: 30,
        interval: 0,
      },
      tokenResponses: [{ error: "slow_down" }, { access_token: "tok-1" }],
    });
    await new Promise<void>((r) => provider!.server.listen(0, r));
    const endpoints = provider.endpoints();
    const device = await requestDeviceCode(endpoints);
    const start = Date.now();
    const result = await pollForToken(endpoints, { ...device, interval: 0 });
    // the spec bumps the interval by 5s on slow_down — real backoff, not skipped
    expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
    expect(result.accessToken).toBe("tok-1");
  }, 8000);

  it("access_denied surfaces as DeviceFlowDeniedError", async () => {
    provider = startFakeProvider({ tokenResponses: [{ error: "access_denied" }] });
    await new Promise<void>((r) => provider!.server.listen(0, r));
    const endpoints = provider.endpoints();
    const device = await requestDeviceCode(endpoints);
    await expect(pollForToken(endpoints, { ...device, interval: 0 })).rejects.toBeInstanceOf(
      DeviceFlowDeniedError,
    );
  });

  it("an already-expired device code surfaces as DeviceFlowExpiredError", async () => {
    provider = startFakeProvider({
      device: {
        user_code: "X",
        device_code: "d",
        verification_uri: "https://example.test",
        expires_in: 0,
        interval: 0,
      },
      tokenResponses: [{ error: "authorization_pending" }],
    });
    await new Promise<void>((r) => provider!.server.listen(0, r));
    const endpoints = provider.endpoints();
    const device = await requestDeviceCode(endpoints);
    await expect(pollForToken(endpoints, device)).rejects.toBeInstanceOf(DeviceFlowExpiredError);
  });

  it("refreshToken exchanges a refresh token for a fresh access token", async () => {
    provider = startFakeProvider({ tokenResponses: [{ access_token: "tok-2", expires_in: 100 }] });
    await new Promise<void>((r) => provider!.server.listen(0, r));
    const result = await refreshToken(provider.endpoints(), "refresh-1");
    expect(result.accessToken).toBe("tok-2");
  });
});
