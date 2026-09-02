import "server-only";

import {
  ObservatoryAdapterError,
  type AbortMissionCommand,
  type CaptureCommand,
  type ObservatoryAdapter,
  type ParkCommand,
  type StartMissionCommand,
} from "@/lib/observatory/adapter";

export class RealObservatoryAdapter implements ObservatoryAdapter {
  async getStatus(): Promise<never> {
    return this.notConfigured("getStatus");
  }

  async getCurrentTarget(): Promise<never> {
    return this.notConfigured("getCurrentTarget");
  }

  async getCoordinates(): Promise<never> {
    return this.notConfigured("getCoordinates");
  }

  async startMission(command: StartMissionCommand): Promise<never> {
    void command;
    return this.notConfigured("startMission");
  }

  async abortMission(command: AbortMissionCommand): Promise<never> {
    void command;
    return this.notConfigured("abortMission");
  }

  async park(command: ParkCommand): Promise<never> {
    void command;
    return this.notConfigured("park");
  }

  async capture(command: CaptureCommand): Promise<never> {
    void command;
    return this.notConfigured("capture");
  }

  async getPreview(): Promise<never> {
    return this.notConfigured("getPreview");
  }

  async getMissionEvents(missionId: string): Promise<never> {
    void missionId;
    return this.notConfigured("getMissionEvents");
  }

  private notConfigured(operation: keyof ObservatoryAdapter): never {
    throw new ObservatoryAdapterError(
      "NOT_CONFIGURED",
      operation,
      "Real observatory protocol is not configured",
    );
  }
}
