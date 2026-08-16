export type RoiDeclineComparison = {
  declined: boolean;
  unavailableInputs: Array<'scan-time ROI' | 'Current ROI'>;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Compare raw ROI percentages without rounding or coercing missing values. */
export function compareRoiDecline(scanTimeRoi: unknown, currentRoi: unknown): RoiDeclineComparison {
  const unavailableInputs: RoiDeclineComparison['unavailableInputs'] = [];
  const scanTimeAvailable = isFiniteNumber(scanTimeRoi);
  const currentAvailable = isFiniteNumber(currentRoi);
  if (!scanTimeAvailable) unavailableInputs.push('scan-time ROI');
  if (!currentAvailable) unavailableInputs.push('Current ROI');

  return {
    declined: scanTimeAvailable && currentAvailable && scanTimeRoi > currentRoi,
    unavailableInputs,
  };
}
