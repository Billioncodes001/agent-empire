export type ConsultancyDecision = 'pending_approval' | 'approved' | 'rejected';

export type ConsultancyStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'needs_attention'
  | 'awaiting_review'
  | 'rejected';

export interface ConsultancyTaskInput {
  title: string;
  prompt: string;
}

export interface ConsultancyCreateInput {
  requestId: string;
  client: string;
  title: string;
  brief: string;
  tasks?: ConsultancyTaskInput[];
}

export interface ConsultancyItem {
  id: string;
  title: string;
  prompt: string;
  jobKey: string;
  queueTaskId?: string;
  status: ConsultancyStatus;
  attention?: string;
}

export interface ConsultancyJob {
  id: string;
  requestId: string;
  client: string;
  title: string;
  brief: string;
  decision: ConsultancyDecision;
  status: ConsultancyStatus;
  createdAt: number;
  createdBy: string;
  decidedAt?: number;
  decidedBy?: string;
  items: ConsultancyItem[];
  attention?: string;
}

export interface ConsultancySnapshot {
  revision: number;
  jobs: ConsultancyJob[];
  storageError?: string;
}
