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
  lcp?: number;        // Largest Contentful Paint, seconds
  tbt?: number;        // Total Blocking Time, ms
  speedIndex?: number; // Speed Index, seconds
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
  aiWebAnalysis?: string;   // 6-field structured text from Claude
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
