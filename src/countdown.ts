import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';

import { PULSE, renderResumeCountdown } from './render.ts';
import type { ResumeScheduleState } from './schedule.ts';

/** TUI component that owns the 1 s pulse interval and delegates drawing to `render.ts`. */
export class ResumeCountdown implements Component {
  private pulseIndex = 0;
  private state: ResumeScheduleState = { phase: 'idle' };
  private modelLabel = '';
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {
    this.timer = setInterval(() => {
      this.pulseIndex = (this.pulseIndex + 1) % PULSE.length;
      this.tui.requestRender();
    }, 1000);
    this.timer.unref?.();
  }

  /** Push new schedule state into the component and trigger a re-render. */
  update(state: ResumeScheduleState, modelLabel: string): void {
    this.state = state;
    this.modelLabel = modelLabel;
    this.tui.requestRender();
  }

  render(): string[] {
    return renderResumeCountdown(
      this.state,
      this.theme,
      Date.now(),
      this.pulseIndex,
      this.modelLabel,
    );
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}
