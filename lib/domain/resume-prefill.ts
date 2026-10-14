import { z } from 'zod';

import type { CafeRole } from './roles.ts';

/** Editable values supported by the candidate application form. */
export const ResumePrefillSchema = z.object({
  fullName: z.string().max(200),
  email: z.string().max(320),
  phone: z.string().max(40),
  city: z.string().max(120),
  yearsExperience: z.enum(['', '0-1', '1-3', '3-5', '5+']),
  skills: z.array(z.string().max(120)).max(50),
  certifications: z.array(z.string().max(120)).max(50),
  languages: z.array(z.string().max(120)).max(8),
}).strict();

export type ResumePrefill = z.infer<typeof ResumePrefillSchema>;

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?<![\d\w])(?:\+?1[.\s-]?)?(?:\(\d{3}\)|\d{3})[.\s-]?\d{3}[.\s-]?\d{4}(?!\d)/u;
const NAME_WORD = /^[\p{L}][\p{L}\p{M}'’.-]*$/u;
const NON_NAME_HEADINGS = new Set([
  'professional summary', 'summary of qualifications', 'work experience',
  'professional experience', 'employment history', 'customer service',
  'contact information', 'education and training', 'skills and experience',
  'curriculum vitae', 'line cook', 'prep cook', 'shift supervisor',
]);

// These are phrases that identify a form choice, not guesses from job titles or
// related responsibilities. The role definition below determines which IDs exist.
const SKILL_PHRASES: Readonly<Record<string, readonly string[]>> = {
  espresso_machine: ['espresso machine', 'espresso machines'],
  customer_service: ['customer service'],
  pos_register: ['pos system', 'pos systems', 'pos register', 'point of sale', 'cash register'],
  cash_handling: ['cash handling', 'handled cash', 'cash management'],
  drink_recipes: ['drink recipes', 'beverage preparation', 'drink preparation'],
  milk_steaming: ['milk steaming', 'milk frothing', 'steamed milk'],
  latte_art: ['latte art'],
  coffee_knowledge: ['coffee bean knowledge', 'coffee knowledge'],
  opening_closing: ['opening and closing', 'opening closing', 'opened and closed', 'opening duties', 'closing duties'],
  inventory: ['inventory management', 'inventory control', 'inventory receiving', 'inventory ordering'],
  training: ['training new hires', 'trained new hires', 'trained staff', 'staff training', 'training others'],
  bilingual: ['bilingual'],
  team_management: ['team management', 'managed a team', 'staff supervision'],
  conflict_resolution: ['conflict resolution', 'resolved conflicts'],
  scheduling: ['staff scheduling', 'employee scheduling', 'shift scheduling'],
  food_safety_mgmt: ['food safety management'],
  pos_admin: ['pos administration', 'point of sale administration'],
  knife_skills: ['knife skills'],
  grill_flattop: ['flat top grill', 'flat top', 'flattop grill', 'grill cooking'],
  food_prep: ['food prep', 'food preparation', 'ingredient prep', 'ingredient preparation'],
  food_safety: ['food safety', 'haccp'],
  ticket_management: ['ticket management', 'kitchen ticket management'],
  cleaning_sanitation: ['cleaning and sanitation', 'cleaning sanitation', 'sanitation'],
  sous_vide: ['sous vide'],
  combi_oven: ['combi oven'],
  pastry_basics: ['basic pastry', 'pastry basics'],
  plating: ['plating', 'plate presentation'],
  portioning: ['portioning', 'portion control'],
  labeling_rotation: ['labeling and rotation', 'food rotation', 'fifo rotation'],
  batch_cooking: ['batch cooking'],
  baking_basics: ['baking basics', 'basic baking'],
  allergen_awareness: ['allergen awareness', 'allergen control'],
  recipe_scaling: ['recipe scaling', 'scaled recipes'],
  basic_math: ['basic math', 'cash math'],
  order_accuracy: ['order accuracy', 'accurate order entry'],
  upselling: ['upselling', 'suggestive selling'],
  food_knowledge: ['menu knowledge', 'food knowledge'],
  cleaning: ['cleaning and organization', 'cleaning organization'],
  phone_etiquette: ['phone etiquette', 'telephone etiquette'],
  loyalty_programs: ['loyalty programs', 'loyalty program'],
  baking_scratch: ['baking from scratch', 'scratch baking'],
  oven_operation: ['oven operation', 'operated ovens'],
  dough_handling: ['dough handling', 'dough shaping'],
  time_management: ['time management'],
  pastry_decoration: ['pastry decoration', 'cake decorating'],
  sourdough: ['sourdough', 'bread fermentation'],
  lamination: ['laminated dough', 'dough lamination'],
  gluten_free: ['gluten free baking', 'gluten free'],
};

const CERTIFICATION_PHRASES: Readonly<Record<string, readonly string[]>> = {
  food_handler: ['food handler permit', 'food handlers permit', 'food handler card', 'food handler certificate', 'food handling certificate'],
  barista_cert: ['barista certification', 'certified barista'],
  servsafe: ['servsafe'],
  first_aid: ['first aid certification', 'first aid certified', 'cpr certification', 'cpr certified', 'first aid cpr'],
  tips: ['tips alcohol certification', 'tips certification', 'tips certified'],
  pastry_cert: ['pastry arts certification', 'pastry certification', 'certified pastry'],
};

const LANGUAGE_PHRASES: Readonly<Record<string, readonly string[]>> = {
  english: ['english'],
  spanish: ['spanish'],
  mandarin: ['mandarin', 'mandarin chinese'],
  hindi: ['hindi'],
  french: ['french'],
  korean: ['korean'],
  portuguese: ['portuguese'],
  arabic: ['arabic'],
};

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[’']/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function hasSupportedPhrase(text: string, phrases: readonly string[]): boolean {
  const padded = ` ${normalize(text)} `;
  return phrases.some(phrase => {
    const target = ` ${normalize(phrase)} `;
    let index = padded.indexOf(target);
    while (index !== -1) {
      const prefix = padded.slice(Math.max(0, index - 55), index);
      if (!/(?:^|\s)(?:no|without|lacks?|not|never)(?:\s+\w+){0,4}$/u.test(prefix)) {
        return true;
      }
      index = padded.indexOf(target, index + 1);
    }
    return false;
  });
}

function cleanLine(line: string): string {
  return line.replace(/^\s*[#>*-]+\s*/u, '')
    .replace(/\*\*/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function validName(raw: string): string {
  const candidate = raw.split(/[|•\t]/u, 1)[0]?.trim() ?? '';
  if (candidate.length < 3 || candidate.length > 100 || /\d|@|https?:/iu.test(candidate)) return '';
  const words = candidate.split(/\s+/u);
  if (words.length < 2 || words.length > 5 || !words.every(word => NAME_WORD.test(word))) return '';
  const normalized = normalize(candidate);
  if (NON_NAME_HEADINGS.has(normalized)
    || /\b(?:resume|candidate|professional|summary|profile|skills|experience|education|certifications|objective|application)\b/u.test(normalized)
    || /\b(?:and|for|with)\b/u.test(normalized)) return '';
  return candidate;
}

function extractName(text: string, lines: readonly string[]): string {
  for (const line of lines.slice(0, 16)) {
    const labeled = /^(?:full\s+name|candidate\s+name|name)\s*:\s*(.+)$/iu.exec(line);
    if (labeled) return validName(labeled[1]);
  }

  const first = lines[0] ?? '';
  const heading = /^(?:#{1,3}\s+)(.+)$/u.exec(first);
  if (heading) return validName(cleanLine(heading[1]));

  // Plain first-line names are common, but require nearby contact evidence so a
  // section heading or role title cannot become an applicant's name.
  const nearbyContact = lines.slice(0, 7).join('\n');
  return EMAIL.test(nearbyContact) || PHONE.test(nearbyContact)
    ? validName(cleanLine(first))
    : '';
}

function extractCity(lines: readonly string[]): string {
  for (const originalLine of lines.slice(0, 30)) {
    const line = cleanLine(originalLine);
    const labeled = /^(?:city|location)\s*:\s*(.+)$/iu.exec(line);
    const basedIn = /^based\s+in\s+(.+)$/iu.exec(line);
    const value = (labeled?.[1] ?? basedIn?.[1] ?? '').split(/[|•]/u, 1)[0]?.trim() ?? '';
    if (!value || value.length > 120 || /\d|@|https?:/iu.test(value)) continue;
    if (/^(?:remote|hybrid|onsite|on site)$/iu.test(value)) continue;
    return value;
  }
  return '';
}

function extractYearsExperience(text: string): ResumePrefill['yearsExperience'] {
  if (/\b(?:less than|under)\s+(?:one|1)\s+year\s+of\s+experience\b/iu.test(text)) return '0-1';
  const years = /\b(\d{1,2})(?:\.\d+)?\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:[\p{L}-]+\s+){0,3}experience\b/iu.exec(text)
    ?? /\bexperience\s*:\s*(\d{1,2})(?:\.\d+)?\+?\s*(?:years?|yrs?)\b/iu.exec(text);
  if (!years) return '';
  const number = Number(years[1]);
  if (number > 80) return '';
  if (number >= 5) return '5+';
  if (number >= 3) return '3-5';
  if (number >= 1) return '1-3';
  return '0-1';
}

function extractLanguages(text: string): string[] {
  const snippets: string[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanLine(lines[index]);
    const labeled = /^languages?\s*:\s*(.*)$/iu.exec(line);
    if (labeled) {
      snippets.push(labeled[1] || cleanLine(lines[index + 1] ?? ''));
    }
    const fluent = /\b(?:fluent\s+in|speak\s+[^.\n]{0,60}?\s+fluently)\s*([^\n.]*)/iu.exec(line);
    if (fluent) snippets.push(fluent[1] || line);
  }
  const evidence = snippets.join(' ');
  return Object.entries(LANGUAGE_PHRASES)
    .filter(([, phrases]) => hasSupportedPhrase(evidence, phrases))
    .map(([id]) => id);
}

/** Extract only facts stated in the resume; omitted facts remain editable blanks. */
export function extractResumePrefill(text: string, role: CafeRole): ResumePrefill {
  const boundedText = text.slice(0, 100_000);
  const lines = boundedText.split(/\r?\n/u).filter(line => line.trim().length > 0);
  const email = EMAIL.exec(boundedText)?.[0] ?? '';
  const phone = PHONE.exec(boundedText)?.[0] ?? '';
  const skills = [...role.essentialSkills, ...role.niceToHaveSkills]
    .filter(skill => hasSupportedPhrase(boundedText, SKILL_PHRASES[skill.id] ?? []))
    .map(skill => skill.id);
  const certifications = role.certifications
    .filter(certification => hasSupportedPhrase(boundedText, CERTIFICATION_PHRASES[certification.id] ?? []))
    .map(certification => certification.id);

  return ResumePrefillSchema.parse({
    fullName: extractName(boundedText, lines),
    email,
    phone,
    city: extractCity(lines),
    yearsExperience: extractYearsExperience(boundedText),
    skills: [...new Set(skills)],
    certifications: [...new Set(certifications)],
    languages: extractLanguages(boundedText),
  });
}
