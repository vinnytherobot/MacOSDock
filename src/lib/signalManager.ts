/**
 * Manages GObject signal connections to prevent leaks.
 * Every connect() must be paired with a disconnectAll() in disable().
 */

type SignalSource = {
  connect(signal: string, callback: (...args: unknown[]) => void): number;
  disconnect(id: number): void;
};

export class SignalManager {
  private _connections: { source: SignalSource; signalId: number }[] = [];

  connect(
    source: SignalSource,
    signal: string,
    callback: (...args: unknown[]) => void,
  ): number {
    const id = source.connect(signal, callback);
    this._connections.push({ source, signalId: id });
    return id;
  }

  disconnectAll(): void {
    for (const conn of this._connections) {
      conn.source.disconnect(conn.signalId);
    }
    this._connections = [];
  }
}
