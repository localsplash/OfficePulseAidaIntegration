import net from 'node:net';

/**
 * Plays the Asterisk side of a FastAGI session over a real TCP socket:
 * sends the agi_* environment, then answers every AGI command the way
 * Asterisk would. Captures SET VARIABLE writes and serves GET VARIABLE
 * reads from a provided map.
 */
export class FakeAsteriskCall {
  readonly setVars = new Map<string, string>();
  readonly commands: string[] = [];
  private socket?: net.Socket;
  private closed!: Promise<void>;

  constructor(
    private readonly env: Record<string, string>,
    private readonly channelVars: Record<string, string> = {},
  ) {}

  async dial(port: number, host = '127.0.0.1'): Promise<void> {
    const socket = net.connect(port, host);
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.on('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const lines = Object.entries(this.env)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    socket.write(lines + '\n\n');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim() === '') continue;
        this.commands.push(line);
        this.respond(line);
      }
    });
    socket.on('error', () => {});
  }

  private respond(command: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    const getMatch = /^GET VARIABLE (\S+)/.exec(command);
    if (getMatch) {
      const value = this.channelVars[getMatch[1] ?? ''];
      socket.write(value !== undefined ? `200 result=1 (${value})\n` : '200 result=0\n');
      return;
    }
    const setMatch = /^SET VARIABLE (\S+) "((?:[^"\\]|\\.)*)"/.exec(command);
    if (setMatch) {
      const raw = setMatch[2] ?? '';
      this.setVars.set(setMatch[1] ?? '', raw.replace(/\\(.)/g, '$1'));
      socket.write('200 result=1\n');
      return;
    }
    socket.write('200 result=1\n');
  }

  async waitForHangup(timeoutMs = 3000): Promise<void> {
    await Promise.race([
      this.closed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('fake call not hung up in time')), timeoutMs).unref()),
    ]);
  }

  destroy(): void {
    this.socket?.destroy();
  }
}
