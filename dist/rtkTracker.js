import { priceFor } from "./pricing.js";
/**
 * Prompt-caching savings. A cache read is billed at ~10% of fresh input
 * for every model in our table (see pricing.ts), so we compute what the
 * read tokens would have cost at full input rate and subtract the actual
 * discounted cost — per model — for a dollar figure that tracks the
 * real pricing table.
 */
export function computeRTKGains(agg) {
    const total = agg.totalTokens;
    // Cache hit ratio = cache reads / (cache reads + fresh input). `cacheCreation`
    // is excluded: those are writes that happened this window and will pay off
    // on later reads; counting them here would deflate the ratio mid-session.
    const freshInputEquivalent = total.input + total.cacheRead;
    const cacheHitRatio = freshInputEquivalent > 0 ? total.cacheRead / freshInputEquivalent : 0;
    // All models in pricing.ts have cache_read billed at 10% of fresh input, so
    // 90% of cacheRead tokens is a universal "tokens saved" figure that doesn't
    // need per-model weighting. Cost saved DOES use per-model rates because the
    // absolute $ saved varies with the input tier.
    const tokensSavedCache = Math.round(total.cacheRead * 0.9);
    let costSavedCache = 0;
    for (const m of agg.models) {
        const p = priceFor(m.model);
        const perTokenSaving = p.input - p.cacheRead; // $/M
        costSavedCache += (m.tokens.cacheRead * perTokenSaving) / 1_000_000;
    }
    return {
        cacheHitRatio,
        tokensSavedCache,
        costSavedCache,
    };
}
//# sourceMappingURL=rtkTracker.js.map