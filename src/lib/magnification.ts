import GLib from "gi://GLib";
import type St from "gi://St";
import { SignalManager } from "./signalManager.js";

type IconActor = InstanceType<typeof St.BoxLayout>;

const MIN_SCALE = 1.0;
const LERP_FACTOR = 0.25; // smoothing factor per tick

export class Magnification {
  private _signals: SignalManager;
  private _container: InstanceType<typeof St.BoxLayout>;
  private _enabled: boolean;
  private _maxScale: number;
  private _falloffDistance: number;
  private _framerate: number;
  private _pollId: number | null = null;
  private _currentScales: number[] = [];

  constructor(
    container: InstanceType<typeof St.BoxLayout>,
    enabled: boolean,
    maxScale: number,
    falloffDistance: number = 100,
    framerate: number = 60,
  ) {
    this._signals = new SignalManager();
    this._container = container;
    this._enabled = enabled;
    this._maxScale = maxScale;
    this._falloffDistance = falloffDistance;
    this._framerate = framerate;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) this._resetAll();
  }

  setMaxScale(scale: number): void {
    this._maxScale = scale;
  }

  setFalloffDistance(distance: number): void {
    this._falloffDistance = distance;
  }

  setFramerate(fps: number): void {
    this._framerate = fps;
    this._restartPoll();
  }

  start(): void {
    this._signals.connect(this._container, "leave-event", () => {
      this._resetAll();
    });
    this._startPoll();
  }

  stop(): void {
    this._signals.disconnectAll();
    this._stopPoll();
    this._resetAll();
  }

  private _startPoll(): void {
    this._stopPoll();
    const interval = Math.round(1000 / this._framerate);
    this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
      this._update();
      return GLib.SOURCE_CONTINUE;
    });
  }

  private _stopPoll(): void {
    if (this._pollId !== null) {
      GLib.source_remove(this._pollId);
      this._pollId = null;
    }
  }

  private _restartPoll(): void {
    if (this._pollId !== null) {
      this._startPoll();
    }
  }

  private _update(): void {
    if (!this._enabled) return;
    if (!this._container.visible) return;

    const [px, py] = global.get_pointer();
    const [dx, dy] = this._container.get_position();
    const [, dh] = this._container.get_size();

    const localX = px - dx;
    const localY = py - dy;

    if (localY < -40 || localY > dh + 20) {
      this._resetAll();
      return;
    }

    const children = this._container.get_children() as IconActor[];
    if (children.length === 0) return;

    // Ensure pivot-point and currentScales array are sized.
    for (const child of children) {
      if (child.get_pivot_point()[0] !== 0.5) {
        child.set_pivot_point(0.5, 1.0);
      }
    }
    while (this._currentScales.length < children.length) {
      this._currentScales.push(MIN_SCALE);
    }

    // Find closest icon to pointer.
    let focalIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < children.length; i++) {
      const [cx] = children[i].get_position();
      const [cw] = children[i].get_size();
      const d = Math.abs(localX - (cx + cw / 2));
      if (d < bestDist) {
        bestDist = d;
        focalIdx = i;
      }
    }

    if (bestDist > this._falloffDistance * 1.5) {
      this._resetAll();
      return;
    }

    // Compute target scales and interpolate.
    const [fx] = children[focalIdx].get_position();
    const [fw] = children[focalIdx].get_size();
    const focalCenter = fx + fw / 2;

    for (let i = 0; i < children.length; i++) {
      const [cx] = children[i].get_position();
      const [cw] = children[i].get_size();
      const dist = Math.abs(cx + cw / 2 - focalCenter);

      const t = Math.max(0, 1 - dist / this._falloffDistance);
      const smooth = t * t * (3 - 2 * t);
      const target = MIN_SCALE + (this._maxScale - MIN_SCALE) * smooth;

      // Lerp towards target.
      const prev = this._currentScales[i] ?? MIN_SCALE;
      const next = prev + (target - prev) * LERP_FACTOR;
      this._currentScales[i] = next;

      children[i].scale_x = next;
      children[i].scale_y = next;
    }
  }

  private _resetAll(): void {
    const children = this._container.get_children() as IconActor[];
    for (let i = 0; i < children.length; i++) {
      const prev = this._currentScales[i] ?? MIN_SCALE;
      if (Math.abs(prev - MIN_SCALE) < 0.001) continue;
      const next = prev + (MIN_SCALE - prev) * LERP_FACTOR;
      this._currentScales[i] = next;
      children[i].scale_x = next;
      children[i].scale_y = next;
    }
  }
}
