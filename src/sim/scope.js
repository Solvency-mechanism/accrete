// Scope manifest: the step-1 content budget Sterling approved on 2026-10-17 (decision D1, the Scope section of AGENTS.md).
// Counts are maxima. tests/scope.test.mjs checks that the shipped data never exceeds them and that they still match
// AGENTS.md. Raising one needs Sterling's sign-off; step 2 (the v1.0 budget) unlocks only when docs/gates/G1.md records a pass.

export const SCOPE_STEP = 1;
export const SCOPE = Object.freeze({
  identities: 2,          // plus Unbound
  forms: 3,               // FORMS_IN_SCOPE; no new forms
  encountersPerForm: 3,
  enemyKinds: 3,          // KINDS_IN_SCOPE; no new kinds
  modifiers: 1,           // Plated
  arrangements: 18,       // regular arrangements, built from the budgeted kinds
  apexes: 3,
  activities: 2,          // Gather, Contest
  adaptations: 10, adaptationTiers: 2,  // tiers I-II
  vows: 3, vowTiers: 2,   // tiers 1-2
  declineOptions: 1, routeRewards: 4,
  finales: 0, endings: 0, journalEntries: 0,
});
// Step 1 names these rosters outright: it adds no form, kind or atlas (apex variants reuse the existing atlases).
export const FORMS_IN_SCOPE = Object.freeze(['dwarf planet', 'planet', 'gas giant']);
export const KINDS_IN_SCOPE = Object.freeze(['charger', 'guard', 'scavenger']);
export const ACTIVITIES_IN_SCOPE = Object.freeze(['gather', 'contest']);
export const ATLASES_IN_SCOPE = Object.freeze(['celestial', 'field']);
