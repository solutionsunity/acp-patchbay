// OAuth Device Flow client (plan.md P9 — "default call is GitHub Device Flow:
// no client secret in an extension, works in remote/WSL"). Plain fetch, no
// vscode dependency, so it's unit-testable against a fake local HTTP server
// standing in for the OAuth provider — the same fixture philosophy as the
// fake ACP agent.
export interface DeviceFlowEndpoints {
  deviceCodeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  /** Seconds from now — undefined means the token never expires. */
  expiresIn?: number;
}

export class DeviceFlowDeniedError extends Error {}
export class DeviceFlowExpiredError extends Error {}

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  return (await response.json()) as Record<string, unknown>;
}

export async function requestDeviceCode(endpoints: DeviceFlowEndpoints): Promise<DeviceCodeResponse> {
  const body = await postForm(endpoints.deviceCodeUrl, {
    client_id: endpoints.clientId,
    scope: endpoints.scopes.join(" "),
  });
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri ?? body.verification_uri_complete),
    expiresIn: Number(body.expires_in),
    interval: Number(body.interval ?? 5),
  };
}

/** Polls until the user approves, denies, or the device code expires —
 * exactly the loop the Device Flow spec (RFC 8628) describes: keep the
 * reported interval, back off on `slow_down`, stop honestly on `access_denied`
 * / `expired_token` rather than retrying forever. */
export async function pollForToken(
  endpoints: DeviceFlowEndpoints,
  device: DeviceCodeResponse,
  signal?: AbortSignal,
): Promise<TokenResult> {
  let interval = device.interval;
  const deadline = Date.now() + device.expiresIn * 1000;
  for (;;) {
    if (signal?.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (Date.now() > deadline) throw new DeviceFlowExpiredError("device code expired");

    const body = await postForm(endpoints.tokenUrl, {
      client_id: endpoints.clientId,
      device_code: device.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (body.error === "access_denied") throw new DeviceFlowDeniedError("user denied access");
    if (body.error === "expired_token") throw new DeviceFlowExpiredError("device code expired");
    if (typeof body.error === "string") throw new Error(`device flow error: ${body.error}`);

    return {
      accessToken: String(body.access_token),
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
    };
  }
}

export async function refreshToken(
  endpoints: DeviceFlowEndpoints,
  refreshTokenValue: string,
): Promise<TokenResult> {
  const body = await postForm(endpoints.tokenUrl, {
    client_id: endpoints.clientId,
    refresh_token: refreshTokenValue,
    grant_type: "refresh_token",
  });
  if (typeof body.error === "string") throw new Error(`refresh failed: ${body.error}`);
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : refreshTokenValue,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
  };
}
