import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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

test('manager interactions expose demo provenance and truthful status dialogs', () => {
  const dashboard = source('components/candidates/manager-dashboard.tsx');
  const personaSettings = source('components/hiring-personas/persona-settings.tsx');
  const dialog = source('components/ui/dialog.tsx');
  const board = source('components/candidates/candidate-board.tsx');
  const card = source('components/candidates/candidate-card.tsx');

  assert.match(dashboard, /Local demo:/u);
  assert.match(dashboard, /Do not use them for hiring decisions/u);
  assert.match(dashboard, /<Dialog open=/u);
  assert.match(dashboard, /<DialogContent/u);
  assert.match(dashboard, /<DialogTitle/u);
  assert.match(dashboard, /<DialogDescription/u);
  assert.match(dashboard, /aria-label="Open hiring persona settings"/u);
  assert.match(dashboard, /sidebarTriggerRef\.current\?\.focus\(\)/u);
  assert.match(dashboard, /candidateSearchRef\.current\?\.focus\(\)/u);
  assert.match(dashboard, /hiredReturnFocusRef\.current\?\.focus\(\)/u);
  assert.match(dashboard, /<caption className="sr-only">/u);
  assert.match(dashboard, /<th scope="col"/u);
  assert.match(dashboard, /<th scope="row"/u);
  assert.match(personaSettings, /<Dialog open/u);
  assert.match(personaSettings, /onOpenAutoFocus=/u);
  assert.match(personaSettings, /onCloseAutoFocus=/u);
  assert.match(personaSettings, /returnFocusRef\.current\.focus\(\)/u);
  assert.match(personaSettings, /htmlFor="persona-job-title"/u);
  assert.match(personaSettings, /aria-label="Close hiring persona settings"/u);
  assert.match(personaSettings, /aria-pressed=/u);
  assert.match(dialog, /DialogPrimitive\.Content/u);
  assert.match(dialog, /DialogPrimitive\.Overlay/u);
  assert.match(dashboard, /No onboarding, account creation, scheduling, or calendar action was performed/u);
  assert.doesNotMatch(dashboard, /Onboarding Complete/u);
  assert.equal(board.includes('aria-label={`Remove '), true);
  assert.match(board, /col\.key !== 'invited'/u);
  assert.match(card, /if \(!res\.ok \|\| !result\?\.success\)/u);
  assert.match(card, /Send invite by text/u);
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
  assert.match(dropZone, /role="progressbar"/u);
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
