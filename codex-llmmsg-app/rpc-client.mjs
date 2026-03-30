import WebSocket from 'ws';

export class CodexRpcClient {
  constructor({ url }) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on('open', resolve);
      ws.on('error', reject);
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }

        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: done, reject: fail } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) fail(new Error(msg.error.message || JSON.stringify(msg.error)));
          else done(msg.result);
        }
      });

      ws.on('close', () => {
        for (const { reject: fail } of this.pending.values()) {
          fail(new Error('websocket closed'));
        }
        this.pending.clear();
      });
    });

    await this.request('initialize', {
      clientInfo: { name: 'codex-llmmsg-app', version: '0.1.0' },
      capabilities: null,
    });
    this.notify('initialized');
  }

  notify(method, params = undefined) {
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    }));
  }

  request(method, params = undefined) {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async close() {
    if (!this.ws) return;
    await new Promise((resolve) => {
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}
