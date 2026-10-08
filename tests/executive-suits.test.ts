import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executiveOutfit } from '../src/client/world/executives.ts';
import { EXECUTIVE_ROLES, EXECUTIVES } from '../src/shared/org.ts';
import type { AvatarId } from '../src/shared/outfit.ts';

// ORG-04a staffs marketing & sales: its suit must never match the chief's, another executive's or the CEO's.
test('every staffed executive wears a distinct suit, never the CEO\'s, whatever the CEO wears', () => {
  const ceos = ['f01', 'f02', 'f03', 'f04', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06'].map((n) => `business-${n}` as AvatarId);
  for (const ceo of ceos) {
    const worn = EXECUTIVE_ROLES.filter((r) => EXECUTIVES[r].active).map((r) => executiveOutfit(r, ceo).avatar);
    assert.equal(new Set(worn).size, worn.length, `${ceo}: ${worn.join(', ')}`);
    assert.ok(!worn.includes(ceo), `${ceo}: ${worn.join(', ')}`);
  }
});
