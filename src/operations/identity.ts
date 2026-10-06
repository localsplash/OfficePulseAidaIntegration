export interface OperatorIdentity {
  active: boolean;
  user?: { iUserId: number; email: string | null; displayName: string | null; superAdmin: boolean };
  tenants?: { iTenantId: number; name: string; bEnabled: boolean }[];
}
export interface OperationsIdentity {
  redeem(code: string, redirectUri: string): Promise<string>;
  introspect(token: string): Promise<OperatorIdentity>;
  revoke(token: string): Promise<void>;
}

/** Uses the same central application-session contract as AidaAdmin. No local users. */
export class HttpOperationsIdentity implements OperationsIdentity {
  constructor(private readonly origin: string, private readonly secret?: string) {}
  private async post(path: string, body: unknown): Promise<any> {
    const response = await fetch(new URL(path, this.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', ...(this.secret ? { 'X-Id-Client-Secret': this.secret } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Identity request unavailable');
    return response.status === 204 ? undefined : response.json();
  }
  async redeem(code: string, redirectUri: string): Promise<string> {
    const result = await this.post('/api/token', { code, redirect_uri: redirectUri });
    const token = result?.appSession?.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/.test(token)) throw new Error('Invalid Identity session');
    return token;
  }
  async introspect(token: string): Promise<OperatorIdentity> {
    return this.post('/api/sessions/introspect', { token });
  }
  async revoke(token: string): Promise<void> { await this.post('/api/sessions/revoke', { token }); }
}
