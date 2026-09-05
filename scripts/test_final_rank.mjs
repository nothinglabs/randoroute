#!/usr/bin/env node
// The final rank (v984) orders and stars the portfolio: every built candidate is
// ranked over the whole corpus by tri-lens cost and by time-and-safety cost, and
// the two ranks are averaged. These are invariants of that arithmetic and of the
// presentation contract, not measurements of any one trip.
import { check, done, routerWorker, appDefaultRules } from './testlib/harness.mjs';

const w = routerWorker();
check('worker loads the graph', w.ready);
const rules = appDefaultRules();
const points = [[-122.3421, 47.6097], [-121.9140, 47.6480]];   // Seattle -> Carnation
const reply = w.post({ type: 'route-options', id: 'fr', points, rules,
  forceDesignated: false, forceResidential: false, preferredProfileId: 'balanced' });
check('the portfolio answers', reply?.ok === true && reply.options.length >= 3,
  JSON.stringify({ ok: reply?.ok, options: reply?.options?.length }));

const all = reply.allCandidates || [];
const ranked = all.filter((c) => c.finalRank);
check('every built candidate carries a final rank', all.length > 6 && ranked.length === all.length,
  `${ranked.length} of ${all.length}`);
check('the score is the mean of the two component ranks',
  ranked.every((c) => Math.abs(c.finalRank.score - (c.finalRank.triLensRank + c.finalRank.suggestionRank) / 2) < 1e-9),
  JSON.stringify(ranked[0]?.finalRank));
check('component ranks run over the whole corpus',
  ranked.every((c) => c.finalRank.of === all.length
    && c.finalRank.triLensRank >= 1 && c.finalRank.triLensRank <= all.length
    && c.finalRank.suggestionRank >= 1 && c.finalRank.suggestionRank <= all.length),
  JSON.stringify(ranked.map((c) => [c.finalRank.triLensRank, c.finalRank.suggestionRank])));
check('each component has exactly one rank-1 holder set (competition ranking)',
  ranked.some((c) => c.finalRank.triLensRank === 1) && ranked.some((c) => c.finalRank.suggestionRank === 1),
  JSON.stringify(ranked.map((c) => c.finalRank)));
// The time-and-safety rank must agree with the shipped score it is derived from.
const byScore = [...ranked].sort((a, b) => a.suggestionScore.totalS - b.suggestionScore.totalS);
check('the time-and-safety rank follows the shipped time-and-safety cost',
  byScore.every((c, i) => i === 0 || c.finalRank.suggestionRank >= byScore[i - 1].finalRank.suggestionRank),
  JSON.stringify(byScore.map((c) => [Math.round(c.suggestionScore.totalS), c.finalRank.suggestionRank])));

const offered = all.filter((c) => c.presented);
const letters = reply.options.map((o) => o.optimization?.profileId);
const offeredInOrder = letters.map((id) => offered.find((c) => c.profileId === id));
check('Route A is the recommended one', reply.options[0].optimization?.recommended === true
  && reply.options.filter((o) => o.optimization?.recommended).length === 1);
check('letters after A run in non-decreasing final rank',
  offeredInOrder.slice(1).every((c, i) => i === 0 || c.finalRank.score >= offeredInOrder[i].finalRank.score),
  offeredInOrder.map((c) => `${c.label}:${c.finalRank.score}`).join(' '));
const star = offeredInOrder[0];
const basis = star.recommendationBasis;
check('the star is the final-rank leader of the offered set unless a named exception moved it',
  basis === 'lowest-final-rank'
    ? offeredInOrder.every((c) => c.finalRank.score >= star.finalRank.score)
    : ['fail-share-guard', 'preferred-route-override'].includes(basis),
  JSON.stringify({ basis, star: star.finalRank, offered: offeredInOrder.map((c) => c.finalRank.score) }));

// Pure score-based sorting seats the top six by the same score.
const pure = w.post({ type: 'route-options', id: 'fr-pure', points,
  rules: { ...rules, pureScoreSort: true },
  forceDesignated: false, forceResidential: false, preferredProfileId: 'balanced' });
const pureAll = pure.allCandidates || [];
const pureOffered = pure.options.map((o) => pureAll.find((c) => c.profileId === o.optimization?.profileId));
check('pure score-based sorting orders the seats by final rank',
  pure?.ok && pureOffered.length >= 3
    && pureOffered.slice(1).every((c, i) => i === 0 || c.finalRank.score >= pureOffered[i].finalRank.score),
  pureOffered.map((c) => `${c?.label}:${c?.finalRank?.score}`).join(' '));

done();
