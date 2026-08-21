import type {
  PresenceActivity,
  PresenceConnectionState,
  PresenceProvider,
  PresenceStatus,
} from "./types";

export class PresenceCoordinator {
  private activity: PresenceActivity | null = null;

  constructor(
    private readonly provider: PresenceProvider,
    private enabled = false,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      void this.provider.connect();
    } else {
      this.activity = null;
      void this.provider.setActivity(null);
    }
  }

  update(activity: PresenceActivity): void {
    if (!this.enabled) return;
    if (JSON.stringify(this.activity) === JSON.stringify(activity)) return;
    this.activity = activity;
    void this.provider.setActivity(activity);
  }

  clear(): void {
    this.activity = null;
    void this.provider.setActivity(null);
  }

  status(): PresenceStatus {
    const connection: PresenceConnectionState = this.enabled
      ? this.provider.status()
      : "disabled";
    return { enabled: this.enabled, provider: "discord", connection };
  }

  close(): void {
    this.activity = null;
    this.provider.close();
  }
}
