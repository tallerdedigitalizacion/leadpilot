export type LeadStatus =
  | 'DISCARDED'
  | 'ARCHIVED'
  | 'QUALIFIED'
  | 'ANALYZED'
  | 'SENT'
  | 'ENGAGED'
  | 'BOOKED'
  | 'FOLLOWUP_1'
  | 'FOLLOWUP_2';

export interface PageSpeedScore {
  performance: number;
  accessibility: number;
  seo: number;
  bestPractices: number;
  lcp?: number;
  tbt?: number;
  speedIndex?: number;
  fetchedAt: number;
}

export interface TimelineEvent {
  at: number;
  event: string;
  by: 'system' | 'user';
  note?: string;
  meta?: Record<string, unknown>;
}

export interface WebAnalysis {
  headlinePain: string;
  visualAssessment: string;
  performanceSummary: {
    mobileScore: number;
    desktopScore: number;
    coreWebVitalsIssues: string[];
  };
  complianceFlag: string;
  top3Fixes: string[];
  closingHook: string;
}

export type ScrapeJobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
export type ScrapeProvider = 'gosom' | 'serpapi';

export interface ScrapeJob {
  jobId: string;
  status: ScrapeJobStatus;
  provider: ScrapeProvider;
  query: string;
  city: string;
  extractEmails: boolean;
  resultCount?: number;
  createdCount?: number;
  skippedCount?: number;
  errorMessage?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface LeadItem {
  leadId: string;
  status: LeadStatus;
  businessName: string;
  url: string;
  phone?: string;
  email?: string;
  emails?: string[];
  city?: string;
  category?: string;
  sponsored?: boolean;
  createdAt: number;
  qualifiedAt?: number;
  analyzedAt?: number;
  sentAt?: number;
  engagedAt?: number;
  clickCount?: number;
  lastClickedAt?: number;
  unsubscribed?: boolean;
  unsubscribedAt?: number;
  bookingUid?: string;
  bookingStartTime?: number;
  bookingEndTime?: number;
  bookingCancelledAt?: number;
  followup1SentAt?: number;
  followup2SentAt?: number;
  pagespeedMobile?: PageSpeedScore;
  pagespeedDesktop?: PageSpeedScore;
  pagespeedMobileRaw?: string;
  pagespeedDesktopRaw?: string;
  webAnalysis?: WebAnalysis;
  screenshotS3Key?: string;
  screenshotUrl?: string; // calculado por get-lead en cada request, nunca persistido
  cookieDetected?: boolean;
  cookieTool?: string;
  myNotes?: string;
  isGeneratingReport?: boolean;
  reportGenerationStartedAt?: number;
  reportHtmlS3Key?: string;
  reportUrl?: string;
  emailSubject?: string;
  emailBody?: string;
  linkedinPost?: string;
  followUpNotes?: string;
  timeline: TimelineEvent[];
}
