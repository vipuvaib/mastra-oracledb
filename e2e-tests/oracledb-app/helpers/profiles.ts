const application = {
  smoke: ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07'],
  e2e: [
    'A01',
    'A02',
    'A03',
    'A04',
    'A05',
    'A06',
    'A07',
    'A08',
    'B01',
    'B02',
    'B03',
    'B04',
    'B05',
    'B06',
    'B07',
    'B08',
    'C01',
    'C02',
    'C03',
    'C04',
    'D01',
    'D02',
    'D03',
    'D04',
    'D05',
    'D06',
    'E01',
    'E02',
    'E03',
    'F01',
    'F02',
    'F03',
    'F04',
  ],
  live: ['L01', 'L02'],
} as const;
export const acceptance = {
  ...application,
  certification: [...application.e2e, 'Q01', 'Q02', 'R01', 'R02', 'S01'],
} as const;

export function validateCoverage(mode: keyof typeof acceptance, assertions: { fullName: string; status: string }[]) {
  for (const id of acceptance[mode]) {
    const matches = assertions.filter(test => new RegExp(`\\b${id}\\b`).test(test.fullName));
    if (matches.length !== 1 || matches[0]?.status !== 'passed') {
      throw new Error(`Mandatory scenario ${id} did not pass exactly once.`);
    }
  }
}
