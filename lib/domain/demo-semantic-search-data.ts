export type SyntheticSourceBlock = {
  sourceBlockId: string;
  section: string;
  blockNumber: number;
  text: string;
  topics: readonly string[];
};

export type SyntheticCandidateProfile = {
  candidateRef: string;
  displayName: string;
  headline: string;
  location: string;
  yearsExperience: number;
  skills: readonly string[];
  sourceBlocks: readonly SyntheticSourceBlock[];
};

// This corpus is intentionally fictional and contains no contact information. The
// canonical source blocks are the only passages the public demo may cite.
export const SYNTHETIC_CANDIDATE_CORPUS = [
  {
    candidateRef: 'SYN-CAND-001',
    displayName: 'Maya T.',
    headline: 'Cafe operations lead',
    location: 'Jersey City, NJ',
    yearsExperience: 6,
    skills: ['Shift leadership', 'Barista training', 'Inventory', 'Weekend openings'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-001-B01',
        section: 'Experience',
        blockNumber: 1,
        text: 'Led a six-person cafe opening team, assigned stations, and kept service moving during 250-order weekend rushes.',
        topics: ['Leadership', 'High-volume service', 'Weekend availability'],
      },
      {
        sourceBlockId: 'SYN-RES-001-B02',
        section: 'Training',
        blockNumber: 2,
        text: 'Created a two-week barista onboarding checklist and coached eight new hires on espresso calibration, milk texture, and POS recovery.',
        topics: ['Barista training', 'Espresso', 'POS systems'],
      },
      {
        sourceBlockId: 'SYN-RES-001-B03',
        section: 'Operations',
        blockNumber: 3,
        text: 'Owned weekly bean and dairy counts, reduced stockouts, and is available for Saturday and Sunday opening shifts.',
        topics: ['Inventory', 'Opening shifts', 'Weekend availability'],
      },
    ],
  },
  {
    candidateRef: 'SYN-CAND-002',
    displayName: 'Leo M.',
    headline: 'Specialty coffee barista',
    location: 'Hoboken, NJ',
    yearsExperience: 4,
    skills: ['Espresso', 'Latte art', 'Customer service', 'POS systems'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-002-B01',
        section: 'Experience',
        blockNumber: 1,
        text: 'Dialed in two espresso grinders each morning and prepared milk and alternative-milk drinks during high-volume service.',
        topics: ['Espresso', 'Morning shifts', 'High-volume service'],
      },
      {
        sourceBlockId: 'SYN-RES-002-B02',
        section: 'Skills',
        blockNumber: 2,
        text: 'Completed an in-house latte art assessment covering hearts, tulips, milk temperature, and drink presentation.',
        topics: ['Latte art', 'Quality control', 'Coffee service'],
      },
      {
        sourceBlockId: 'SYN-RES-002-B03',
        section: 'Service',
        blockNumber: 3,
        text: 'Resolved guest concerns at the counter, processed refunds in the POS, and regularly worked Friday and Saturday closing shifts.',
        topics: ['Customer service', 'POS systems', 'Closing shifts'],
      },
    ],
  },
  {
    candidateRef: 'SYN-CAND-003',
    displayName: 'Priya S.',
    headline: 'Artisan bakery specialist',
    location: 'Newark, NJ',
    yearsExperience: 5,
    skills: ['Sourdough', 'Recipe scaling', 'Oven operations', 'Food safety'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-003-B01',
        section: 'Production',
        blockNumber: 1,
        text: 'Mixed, folded, shaped, and baked 180 sourdough loaves per production day while maintaining fermentation logs.',
        topics: ['Sourdough', 'Bakery production', 'Quality control'],
      },
      {
        sourceBlockId: 'SYN-RES-003-B02',
        section: 'Operations',
        blockNumber: 2,
        text: 'Scaled formulas between 24- and 160-unit batches, documented yields, and coordinated deck-oven loading schedules.',
        topics: ['Recipe scaling', 'Oven operations', 'Production planning'],
      },
      {
        sourceBlockId: 'SYN-RES-003-B03',
        section: 'Certification',
        blockNumber: 3,
        text: 'Maintains a current food-handler certificate and is available for production shifts beginning at 4:30 a.m.',
        topics: ['Food safety', 'Certification', 'Early-morning availability'],
      },
    ],
  },
  {
    candidateRef: 'SYN-CAND-004',
    displayName: 'Sam R.',
    headline: 'High-volume line cook',
    location: 'Union City, NJ',
    yearsExperience: 4,
    skills: ['Knife skills', 'Grill', 'Food prep', 'ServSafe'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-004-B01',
        section: 'Experience',
        blockNumber: 1,
        text: 'Worked grill and saute stations through 300-cover dinner services while communicating ticket timing with expo.',
        topics: ['Line cooking', 'High-volume service', 'Team communication'],
      },
      {
        sourceBlockId: 'SYN-RES-004-B02',
        section: 'Preparation',
        blockNumber: 2,
        text: 'Completed daily knife prep, portioned proteins, labeled ingredients, and recorded holding temperatures before service.',
        topics: ['Knife skills', 'Food prep', 'Food safety'],
      },
      {
        sourceBlockId: 'SYN-RES-004-B03',
        section: 'Certification',
        blockNumber: 3,
        text: 'Earned ServSafe Manager certification and routinely completed closing sanitation and waste logs.',
        topics: ['ServSafe', 'Closing shifts', 'Sanitation'],
      },
    ],
  },
  {
    candidateRef: 'SYN-CAND-005',
    displayName: 'Jordan E.',
    headline: 'Customer experience associate',
    location: 'Bayonne, NJ',
    yearsExperience: 3,
    skills: ['Guest recovery', 'Cash handling', 'POS systems', 'Retail service'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-005-B01',
        section: 'Service',
        blockNumber: 1,
        text: 'Supported a busy service desk, de-escalated guest concerns, and documented resolutions for supervisor follow-up.',
        topics: ['Customer service', 'Guest recovery', 'Communication'],
      },
      {
        sourceBlockId: 'SYN-RES-005-B02',
        section: 'Transactions',
        blockNumber: 2,
        text: 'Balanced a cash drawer, processed exchanges, and used a cloud POS for approximately 140 transactions per shift.',
        topics: ['Cash handling', 'POS systems', 'Retail service'],
      },
      {
        sourceBlockId: 'SYN-RES-005-B03',
        section: 'Availability',
        blockNumber: 3,
        text: 'Available for weekday evenings and both weekend days, including scheduled holiday retail periods.',
        topics: ['Evening availability', 'Weekend availability', 'Retail service'],
      },
    ],
  },
  {
    candidateRef: 'SYN-CAND-006',
    displayName: 'Taylor N.',
    headline: 'Restaurant shift supervisor',
    location: 'New York, NY',
    yearsExperience: 7,
    skills: ['Team coaching', 'Scheduling', 'Conflict resolution', 'Inventory'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-006-B01',
        section: 'Leadership',
        blockNumber: 1,
        text: 'Supervised teams of up to 12, ran shift huddles, reassigned stations during rushes, and completed manager handoff notes.',
        topics: ['Leadership', 'Team coaching', 'High-volume service'],
      },
      {
        sourceBlockId: 'SYN-RES-006-B02',
        section: 'Scheduling',
        blockNumber: 2,
        text: 'Built weekly schedules around forecast demand, approved shift swaps, and maintained coverage for opening and closing shifts.',
        topics: ['Scheduling', 'Opening shifts', 'Closing shifts'],
      },
      {
        sourceBlockId: 'SYN-RES-006-B03',
        section: 'Operations',
        blockNumber: 3,
        text: 'Investigated register variances, coached employees through service conflicts, and placed weekly food and packaging orders.',
        topics: ['Conflict resolution', 'Cash controls', 'Inventory'],
      },
    ],
  },
  {
    candidateRef: 'SYN-CAND-007',
    displayName: 'Noah W.',
    headline: 'Entry-level hospitality associate',
    location: 'Secaucus, NJ',
    yearsExperience: 1,
    skills: ['Hospitality', 'Teamwork', 'Event service', 'Weekend availability'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-007-B01',
        section: 'Experience',
        blockNumber: 1,
        text: 'Supported registration, guest directions, and room resets for community events serving up to 200 attendees.',
        topics: ['Hospitality', 'Customer service', 'Event service'],
      },
      {
        sourceBlockId: 'SYN-RES-007-B02',
        section: 'Teamwork',
        blockNumber: 2,
        text: 'Rotated between setup, service, and cleanup tasks and checked in with the team lead before each handoff.',
        topics: ['Teamwork', 'Reliability', 'Service operations'],
      },
      {
        sourceBlockId: 'SYN-RES-007-B03',
        section: 'Availability',
        blockNumber: 3,
        text: 'Seeking a first cafe role and available for Saturday, Sunday, and three weekday evening shifts.',
        topics: ['Entry level', 'Weekend availability', 'Evening availability'],
      },
    ],
  },
  {
    candidateRef: 'SYN-CAND-008',
    displayName: 'Amina O.',
    headline: 'Food retail inventory coordinator',
    location: 'Brooklyn, NY',
    yearsExperience: 6,
    skills: ['Inventory control', 'Receiving', 'Vendor coordination', 'Food safety'],
    sourceBlocks: [
      {
        sourceBlockId: 'SYN-RES-008-B01',
        section: 'Inventory',
        blockNumber: 1,
        text: 'Maintained cycle counts across two food retail locations and reconciled receiving records against purchase orders.',
        topics: ['Inventory control', 'Multi-site operations', 'Receiving'],
      },
      {
        sourceBlockId: 'SYN-RES-008-B02',
        section: 'Vendors',
        blockNumber: 2,
        text: 'Coordinated delivery windows with eight vendors, documented shortages, and followed up on substitutions before service.',
        topics: ['Vendor coordination', 'Receiving', 'Operations'],
      },
      {
        sourceBlockId: 'SYN-RES-008-B03',
        section: 'Compliance',
        blockNumber: 3,
        text: 'Checked cold-chain temperatures, rotated dated stock using FIFO, and prepared weekly waste and variance reports.',
        topics: ['Food safety', 'Quality control', 'Inventory reporting'],
      },
    ],
  },
] as const satisfies readonly SyntheticCandidateProfile[];
