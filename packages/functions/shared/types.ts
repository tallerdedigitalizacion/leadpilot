export type LeadStatus =
  | 'REVIEWING'
  | 'DISCARDED'
  | 'QUALIFIED'
  | 'ANALYZED'
  | 'SENT'
  | 'CALLED'
  | 'RESPONDED'
  | 'NO_RESPONSE';

export interface PageSpeedScore {
  performance: number;
  accessibility: number;
  seo: number;
  bestPractices: number;
  fetchedAt: number;
}

export interface TimelineEvent {
  at: number;
  event: string;
  by: 'system' | 'user';
  note?: string;
}

export interface LeadItem {
  leadId: string;
  status: LeadStatus;
  businessName: string;
  url: string;
  phone?: string;
  email?: string;
  city?: string;
  category?: string;
  createdAt: number;
  qualifiedAt?: number;
  analyzedAt?: number;
  sentAt?: number;
  pagespeedMobile?: PageSpeedScore;
  pagespeedDesktop?: PageSpeedScore;
  aiWebAnalysis?: string;
  myNotes?: string;
  reportHtmlS3Key?: string;
  reportPdfS3Key?: string;
  emailSubject?: string;
  emailBody?: string;
  linkedinPost?: string;
  calendarLink?: string;
  followUpNotes?: string;
  respondedAt?: number;
  timeline: TimelineEvent[];
}
