import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CAFE_ROLES, getRoleById } from '../../lib/domain/roles.ts';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

test('candidate completion is success-gated and copy does not promise unscheduled work', () => {
  const applicationFlow = source('components/candidate-application/application-flow.tsx');

  assert.match(applicationFlow, /if \(res\.ok && result\?\.success\)/u);
  assert.match(applicationFlow, /setStep\(result\.passed \? 'complete' : 'needsReview'\)/u);
  assert.match(applicationFlow, /this client never makes an adverse hiring decision/u);
  assert.match(applicationFlow, /← Back and review/u);
  assert.match(applicationFlow, /const selectedAnswer = answers\[question\.id\]/u);
  assert.match(applicationFlow, /aria-pressed=\{selectedAnswer === true\}/u);
  assert.match(applicationFlow, /aria-pressed=\{selectedAnswer === false\}/u);
  assert.match(applicationFlow, /aria-pressed=\{selectedAnswer === option\}/u);
  assert.match(applicationFlow, /no automated[\s\S]{0,100}rejection or interview decision was made/u);
  assert.match(applicationFlow, /Your answers are still here/u);
  assert.match(applicationFlow, /No interview has been scheduled/u);
  assert.match(applicationFlow, /transitionHeadingRef\.current\?\.focus\(\)/u);
  assert.match(applicationFlow, /\[currentQuestion, step\]/u);
  assert.match(applicationFlow, /ref=\{transitionHeadingRef\} tabIndex=\{-1\}/u);
  assert.doesNotMatch(applicationFlow, /Submit & Schedule Interview/u);
  assert.doesNotMatch(applicationFlow, /confirmation text\/email/u);
});

test('candidate form controls expose labels, grouped choices, and keyboard-native toggles', () => {
  const basicInfo = source('components/candidate-application/basic-info.tsx');
  const profile = source('components/candidate-application/candidate-profile.tsx');
  const skills = source('components/candidate-application/skills-experience.tsx');
  const motivation = source('components/candidate-application/motivation-questions.tsx');

  assert.match(basicInfo, /htmlFor="candidate-full-name"/u);
  assert.match(basicInfo, /htmlFor="candidate-email"/u);
  assert.match(basicInfo, /htmlFor="candidate-phone"/u);
  assert.match(basicInfo, /className="peer sr-only"/u);
  assert.match(basicInfo, /peer-focus-visible:ring-2/u);

  for (const component of [basicInfo, profile, skills, motivation]) {
    assert.match(component, /<fieldset/u);
    assert.match(component, /type="button"/u);
    assert.match(component, /aria-pressed=/u);
  }
  assert.doesNotMatch(profile, /<Badge[\s\S]{0,200}onClick=/u);
  assert.doesNotMatch(skills, /<Badge[\s\S]{0,200}onClick=/u);
});

test('the local role questionnaire excludes age from automated knockout criteria', () => {
  const roles = source('lib/domain/roles.ts');
  const dashboard = source('components/candidates/manager-dashboard.tsx');

  assert.doesNotMatch(roles, /years of age|Must be 18\+/u);
  assert.doesNotMatch(dashboard, /Must be 18\+/u);
  assert.doesNotMatch(roles, /id: '[a-z]+_(?:lift|standing|transport)'/u);
});

test('the Cocoa Bakery role catalog includes Prep Cook and preserves the Shift Supervisor identity', () => {
  const roleIds = CAFE_ROLES.map(role => role.id);
  const prepCook = getRoleById('prep_cook');
  const shiftSupervisor = getRoleById('shift_lead');

  assert.equal(new Set(roleIds).size, roleIds.length);
  assert.equal(CAFE_ROLES.length, 6);
  assert.equal(prepCook?.title, 'Prep Cook');
  assert.equal(prepCook?.id, 'prep_cook');
  assert.ok(prepCook?.questions.knockout.length);
  assert.ok(prepCook?.questions.skills.length);
  assert.ok(prepCook?.questions.motivation.length);
  assert.equal(shiftSupervisor?.id, 'shift_lead');
  assert.equal(shiftSupervisor?.title, 'Shift Supervisor');
});

test('candidate flow and choice grids retain a reachable single-column mobile layout', () => {
  const applicationFlow = source('components/candidate-application/application-flow.tsx');
  const basicInfo = source('components/candidate-application/basic-info.tsx');
  const profile = source('components/candidate-application/candidate-profile.tsx');
  const skills = source('components/candidate-application/skills-experience.tsx');

  assert.match(applicationFlow, /grid grid-cols-5 gap-1/u);
  assert.match(applicationFlow, /min-w-0 max-w-lg overflow-hidden/u);
  assert.match(applicationFlow, /px-2 py-4 sm:items-center/u);
  assert.match(basicInfo, /grid grid-cols-1 gap-2 sm:grid-cols-2/u);
  assert.match(profile, /grid grid-cols-1 gap-2 min-\[390px\]:grid-cols-2/u);
  assert.match(skills, /grid grid-cols-1 gap-2 min-\[390px\]:grid-cols-2/u);
});

test('the Cocoa dashboard keeps public mutations gated and its manager controls accessible', () => {
  const page = source('app/page.tsx');
  const dashboard = source('components/candidates/manager-dashboard.tsx');
  const personaSettings = source('components/hiring-personas/persona-settings.tsx');
  const dialog = source('components/ui/dialog.tsx');
  const board = source('components/candidates/candidate-board.tsx');
  const card = source('components/candidates/candidate-card.tsx');
  const scoreRing = source('components/candidates/score-ring.tsx');
  const onboarding = source('components/ui/onboarding-banner.tsx');

  assert.match(page, /href="#main-content"/u);
  assert.match(page, /<ManagerDashboard interactiveDemoEnabled=\{legacyDemoRoutesEnabled\(\)\}/u);
  assert.match(dashboard, /<main id="main-content"/u);
  assert.match(dashboard, /if \(!interactiveDemoEnabled\) return;/u);
  assert.match(dashboard, /Invitations are disabled in the public preview/u);
  assert.match(dashboard, /disabled=\{!interactiveDemoEnabled\}/u);
  assert.match(dashboard, /debugMode \?/u);
  assert.match(onboarding, /sample applicants/u);
  assert.match(onboarding, /aria-label="Dismiss welcome guide"/u);
  assert.match(dashboard, /<Dialog open=/u);
  assert.match(dashboard, /<DialogContent/u);
  assert.match(dashboard, /<DialogTitle/u);
  assert.match(dashboard, /<DialogDescription/u);
  assert.match(dashboard, /mobileSettingsTriggerRef\.current\?\.focus\(\)/u);
  assert.match(dashboard, /hiredReturnFocusRef\.current\?\.focus\(\)/u);
  assert.match(personaSettings, /<Dialog open/u);
  assert.match(personaSettings, /onOpenAutoFocus=/u);
  assert.match(personaSettings, /onCloseAutoFocus=/u);
  assert.match(personaSettings, /returnFocusRef\.current\.focus\(\)/u);
  assert.match(personaSettings, /htmlFor="persona-job-title"/u);
  assert.match(personaSettings, /aria-label="Close hiring settings"/u);
  assert.match(personaSettings, /aria-pressed=/u);
  assert.match(dialog, /DialogPrimitive\.Content/u);
  assert.match(dialog, /DialogPrimitive\.Overlay/u);
  assert.match(board, /aria-label="Candidate hiring pipeline"/u);
  assert.match(board, /event\.key !== 'ArrowDown' && event\.key !== 'ArrowUp'/u);
  assert.match(board, /querySelectorAll<HTMLElement>\('\[data-candidate-card\]'\)/u);
  assert.match(card, /tabIndex=\{0\}/u);
  assert.match(card, /event\.key === 'Enter' \|\| event\.key === ' '/u);
  assert.equal(card.includes('aria-label={`Remove ${candidate.name}`}'), true);
  assert.match(card, /aria-haspopup="menu"/u);
  assert.match(card, /role="menuitem"/u);
  assert.match(scoreRing, /Fit score: \$\{boundedScore\}\. Click to see breakdown\./u);
  assert.match(scoreRing, /aria-expanded=\{expanded\}/u);
  assert.doesNotMatch(card, /candidateEmail:/u);
});

test('toasts and file processing status are announced and dismissible by name', () => {
  const toast = source('components/ui/toast.tsx');
  const dropZone = source('components/candidates/drop-zone.tsx');

  assert.equal(toast.includes("role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}"), true);
  assert.match(toast, /aria-label="Dismiss notification"/u);
  assert.match(toast, /min-h-11 min-w-11/u);
  assert.match(dropZone, /Browse files/u);
  assert.match(dropZone, /role="status"/u);
  assert.match(dropZone, /aria-live="polite"/u);
  assert.match(dropZone, /aria-label="Choose résumé files"/u);
  assert.match(dropZone, /Résumé processing is disabled in the public preview/u);
  assert.match(dropZone, /new FileReader\(\)/u);
  assert.match(dropZone, /candidateIdFromPayload\(payload\)/u);
});

test('the global demo switch names its destination and keeps a mobile-size target', () => {
  const demoToggle = source('components/shared/demo-toggle.tsx');

  assert.equal(
    demoToggle.includes('aria-label={`Switch to ${destinationView.toLowerCase()} view`}'),
    true,
  );
  assert.match(demoToggle, /min-h-11/u);
  assert.match(demoToggle, /Switch to \{destinationView\}/u);
});

test('the unified dashboard embeds an accessible evidence-led Smart Search', () => {
  const page = source('app/page.tsx');
  const dashboard = source('components/candidates/manager-dashboard.tsx');
  const smartSearch = source('components/search/smart-search-tab.tsx');
  const search = source('components/demo/recruiter-semantic-search.tsx');

  assert.match(page, /ManagerDashboard/u);
  assert.match(page, /Skip to main content/u);
  assert.match(dashboard, /<SmartSearchTab debugMode=\{debugMode\}/u);
  assert.match(smartSearch, /<h2 id="smart-search-tab-title"/u);
  assert.match(smartSearch, /respects the current board filters\. Each result includes quoted résumé evidence/u);
  assert.match(smartSearch, /candidateRefs=\{candidateRefs\}/u);
  assert.match(dashboard, /roleId=\{selectedRoleId\} candidateRefs=\{searchCandidateRefs\}/u);

  assert.match(search, /<form role="search"/u);
  assert.match(search, /htmlFor="semantic-candidate-query"/u);
  assert.match(search, /aria-describedby="semantic-query-guidance"/u);
  assert.match(search, /maxLength=\{280\}/u);
  assert.match(search, /aria-label=\{state.loading \? 'Searching' : 'Search fictional profiles'\}/u);
  assert.match(search, /aria-live="polite"/u);
  assert.match(search, /role="alert"/u);
  assert.match(search, /Shift supervisor with scheduling/u);
  assert.match(search, /Why this result appeared/u);
  assert.match(search, /Evidence relevance only—never a fit score or hiring recommendation/u);
  assert.match(search, /aria-label="Evidence topics"/u);
  assert.match(search, /state\.response\.warnings\.map/u);
  assert.match(search, /debugMode \? <p[\s\S]{0,160}similarity=/u);
  assert.match(search, /<ol className="mt-5 grid gap-5" aria-label="Smart Search results"/u);
  assert.match(search, /<blockquote/u);
  assert.match(search, /<figcaption/u);
  assert.match(search, /citation\.citation_id/u);
  assert.match(search, /result\.evidence_topics/u);
  assert.match(search, /sm:flex-row/u);
});
