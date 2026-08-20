export const SCAN_STATUS_HEADER_EXPLANATION = 'Scan Status describes the scan job lifecycle, not the market lifecycle, resolution, or settlement.';

export type ScanStatusTone = 'success' | 'progress' | 'warning' | 'error' | 'unavailable';

export interface ScanStatusPresentation {
  label: string;
  explanation: string;
  tone: ScanStatusTone;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function scanStatusPresentation(
  status: string | null | undefined,
  persistedReason?: string | null,
): ScanStatusPresentation {
  const normalized = status?.trim().toLowerCase();

  switch (normalized) {
    case 'pending':
      return { label: 'Pending', explanation: 'Pending means the scan has not started.', tone: 'progress' };
    case 'queued':
      return { label: 'Queued', explanation: 'Queued means the scan has not started.', tone: 'progress' };
    case 'running':
      return { label: 'Running', explanation: 'Running means the scan is executing.', tone: 'progress' };
    case 'completed':
      return {
        label: 'Completed',
        explanation: 'Completed means the scan finished and its result was persisted. The market may still be open; this does not mean it resolved/closed/settled.',
        tone: 'success',
      };
    case 'partial':
    case 'incomplete':
      return {
        label: 'Partial',
        explanation: 'Partial means the scan finished with incomplete sources or results.',
        tone: 'warning',
      };
    case 'failed': {
      const reason = persistedReason?.trim()
        ? sentence(persistedReason)
        : 'No specific failure reason was persisted.';
      return {
        label: 'Failed',
        explanation: `Failed means the scan did not complete successfully. Reason: ${reason} Action: Retry the scan or open scan details to investigate.`,
        tone: 'error',
      };
    }
    default:
      return normalized
        ? {
            label: 'Unknown',
            explanation: `The persisted scan lifecycle value “${status?.trim()}” is not recognized. Action: Retry the scan or inspect scan details; this value does not describe market resolution or settlement.`,
            tone: 'unavailable',
          }
        : {
            label: 'Unavailable',
            explanation: 'No canonical persisted scan lifecycle value was recorded. This does not describe market resolution or settlement.',
            tone: 'unavailable',
          };
  }
}
