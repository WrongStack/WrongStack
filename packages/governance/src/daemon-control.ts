export interface GovernanceDaemonControlStatus {
  readonly projectId: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
}

export interface GovernanceDaemonControlPort {
  status(): GovernanceDaemonControlStatus;
}

export interface GovernanceDaemonShutdownNotice {
  readonly requestId: string;
  readonly expectedInstanceId: string;
  readonly requestedBy: string;
  readonly reason: string;
}
