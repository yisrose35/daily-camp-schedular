
// ============================================================================
// SmartLogicAdapter V36 (UPDATED: GLOBAL MAX USAGE PRE-SCREEN)
// - Checks if a bunk is "Fully Maxed Out" on ALL special activities.
// - If maxed out, they are disqualified from the Special slot immediately.
// - Forces maxed-out bunks to Open/Fallback activities to prevent wasted slots.
// ============================================================================

(function() {
    "use strict";

    window.SmartLogicAdapter = {

        needsGeneration(act) {
            if (!act) return false;
            const a = act.toLowerCase();
            return (
                a.includes("sport") ||
                a.includes("general activity") ||
                a.includes("special")
            );
        },

        // Groups smart tiles into pairs
        preprocessSmartTiles(rawSkeleton, dailyAdj, specials) {
            const jobs = [];
            const byDiv = {};

            rawSkeleton.forEach(t => {
                if (t.type === 'smart') {
                    if (!byDiv[t.division]) byDiv[t.division] = [];
                    byDiv[t.division].push(t);
                }
            });

            Object.keys(byDiv).forEach(div => {
                const tiles = byDiv[div].sort((a, b) => parse(a.startTime) - parse(b.startTime));
                for (let i = 0; i < tiles.length; i += 2) {
                    const A = tiles[i];
                    const B = tiles[i + 1];
                    const sd = A.smartData || {};

                    if (!B) {
                        jobs.push({
                            division: div,
                            main1: sd.main1,
                            main2: sd.main2,
                            fallbackFor: sd.fallbackFor,
                            fallbackActivity: sd.fallbackActivity,
                            blockA: {
                                startMin: parse(A.startTime),
                                endMin: parse(A.endTime),
                                division: div
                            },
                            blockB: null
                        });
                    } else {
                        jobs.push({
                            division: div,
                            main1: sd.main1,
                            main2: sd.main2,
                            fallbackFor: sd.fallbackFor,
                            fallbackActivity: sd.fallbackActivity,
                            blockA: {
                                startMin: parse(A.startTime),
                                endMin: parse(A.endTime),
                                division: div
                            },
                            blockB: {
                                startMin: parse(B.startTime),
                                endMin: parse(B.endTime),
                                division: div
                            }
                        });
                    }
                }
            });

            return jobs;
        },

        // ---------------------------------------------------------
        // GENERATE ASSIGNMENTS (With Global Eligibility Check)
        // ---------------------------------------------------------
        generateAssignments(bunks, job, historical = {}, specialNames = [], activityProps = {}, masterFields = [], dailyFieldAvailability = {}, yesterdayHistory = {}) {

            const main1 = job.main1.trim();
            const main2 = job.main2.trim();
            const fbAct = job.fallbackActivity || "Sports";

            // Identify the Special Act (The "Limited" resource)
            const fbFor = job.fallbackFor || "";
            let specialAct, openAct;

            if (isSame(main1, fbFor)) {
                specialAct = main1;
                openAct = main2;
            } else if (isSame(main2, fbFor)) {
                specialAct = main2;
                openAct = main1;
            } else {
                // Default
                specialAct = main1;
                openAct = main2;
            }

            // ---------------------------------------------------------
            // 1. ELIGIBILITY PRE-SCREEN (Global Max Usage)
            // ---------------------------------------------------------
            // We must check if the bunk has ANY valid special activity options left.
            // If they are maxed out on EVERYTHING, do not give them a Special slot.

            const allSpecials = window.getGlobalSpecialActivities ? window.getGlobalSpecialActivities() : [];
            const eligibleBunks = [];
            const forcedFallbackBunks = [];

            bunks.forEach(b => {
                let hasAtLeastOneOption = false;

                if (allSpecials.length === 0) {
                    // No specials defined? Assume unlimited/valid to prevent blocking.
                    hasAtLeastOneOption = true;
                } else {
                    // Check every special activity
                    for (const s of allSpecials) {
                        const limit = s.maxUsage || 0; // 0 = unlimited
                        const count = historical[b]?.[s.name] || 0;

                        if (limit === 0 || count < limit) {
                            hasAtLeastOneOption = true;
                            break; // Found one valid option, they are eligible for the slot
                        }
                    }
                }

                if (hasAtLeastOneOption) {
                    eligibleBunks.push(b);
                } else {
                    // Bunk is maxed out on ALL specials.
                    forcedFallbackBunks.push(b);
                }
            });

            // ---------------------------------------------------------
            // Helpers
            // ---------------------------------------------------------
            function playedYesterday(bunk) {
                const sched = yesterdayHistory.schedule?.[bunk] || [];
                // CRITICAL FIX: Ensure sched is an Array before calling .some()
                if (!Array.isArray(sched)) return 0;
                
                return sched.some(e => {
                    const act = (e?._activity || "").toLowerCase();
                    return allSpecials.some(s => s.name.toLowerCase() === act);
                }) ? 1 : 0;
            }

            function getCategoryHistory(bunk, actName) {
                if (!historical[bunk]) return 0;
                let sum = 0;
                const lower = actName.toLowerCase();
                // Count ONLY true special names if actName is generic
                const spec = allSpecials.some(s => s.name.toLowerCase() === lower);

                if (spec) {
                    allSpecials.forEach(s => {
                        if (historical[bunk][s.name]) {
                            sum += historical[bunk][s.name];
                        }
                    });
                }
                return sum;
            }

            function getTotalHistory(bunk) {
                if (!historical[bunk]) return 0;
                return Object.values(historical[bunk]).reduce((a, b) => a + b, 0);
            }

            // ---------------------------------------------------------
            // Sort ONLY ELIGIBLE bunks by fairness
            // ---------------------------------------------------------
            const sorted = [...eligibleBunks].sort((a, b) => {
                const A = getCategoryHistory(a, specialAct);
                const B = getCategoryHistory(b, specialAct);
                if (A !== B) return A - B;

                const YA = playedYesterday(a);
                const YB = playedYesterday(b);
                if (YA !== YB) return YA - YB;

                const TA = getTotalHistory(a);
                const TB = getTotalHistory(b);
                if (TA !== TB) return TA - TB;

                return Math.random() - 0.5;
            });

            // ---------------------------------------------------------
            // Determine Capacity
            // ---------------------------------------------------------
            function calcCap(startMin, endMin) {
                const sp = allSpecials.find(s => isSame(s.name, specialAct));
                if (!sp) return 2;
                // Capacity Logic
                if (sp.sharableWith?.capacity) return parseInt(sp.sharableWith.capacity);
                if (sp.sharableWith?.type === 'not_sharable') return 1;
                if (sp.sharableWith?.type === 'all') return 2;
                if (sp.sharable) return 2;
                return 1;
            }

            // ---------------------------------------------------------
            // Block A Assignment
            // ---------------------------------------------------------
            const capA = calcCap(job.blockA.startMin, job.blockA.endMin);
            let countA = 0;
            const block1 = {};
            const winnersA = new Set();

            // 1. Assign Eligible Bunks (Lottery)
            sorted.forEach(bunk => {
                if (countA < capA) {
                    block1[bunk] = specialAct;
                    winnersA.add(bunk);
                    countA++;
                } else {
                    block1[bunk] = openAct;
                }
            });

            // 2. Assign Forced Fallback Bunks (Maxed Out -> Open Act)
            forcedFallbackBunks.forEach(bunk => {
                block1[bunk] = openAct;
            });

            // ---------------------------------------------------------
            // Block B Assignment
            // ---------------------------------------------------------
            const block2 = {};
            if (job.blockB) {
                const capB = calcCap(job.blockB.startMin, job.blockB.endMin);
                let countB = 0;

                const candidates = sorted.filter(b => !winnersA.has(b));
                const forcedOpen = [...winnersA]; // Winners of A must do Open in B

                // Winners of A -> Forced to Open in B
                forcedOpen.forEach(b => block2[b] = openAct);

                // Losers of A (Eligible) -> Try for Special in B
                candidates.forEach(b => {
                    if (countB < capB) {
                        block2[b] = specialAct;
                        countB++;
                    } else {
                        block2[b] = fbAct; // Eligible but no room -> Fallback
                    }
                });

                // Forced Fallback Bunks (Maxed Out) -> Must go to Fallback
                // (They cannot take Special spots, and they just did Open in A)
                forcedFallbackBunks.forEach(bunk => {
                    block2[bunk] = fbAct;
                });
            }

            // ---------------------------------------------------------
            // Create Locked Events
            // ---------------------------------------------------------
            const locked = [];

            function lockBlock(assignments, blockInfo) {
                Object.entries(assignments).forEach(([bunk, act]) => {
                    locked.push({
                        bunk,
                        division: blockInfo.division,
                        start: blockInfo.startMin,
                        end: blockInfo.endMin,
                        activityLabel: act
                    });
                });
            }

            lockBlock(block1, job.blockA);
            if (job.blockB) lockBlock(block2, job.blockB);

            // ---------------------------------------------------------
            // Pre-save history
            // ---------------------------------------------------------
            window.__smartTileToday = window.__smartTileToday || {};
            window.__smartTileToday[job.division] = {
                specialAct,
                block1,
                block2
            };

            return {
                block1Assignments: block1,
                block2Assignments: block2,
                lockedEvents: locked
            };
        }
    };

    // Helpers
    function parse(str) {
        if (!str) return 0;
        let s = str.trim().toLowerCase();
        let am = s.endsWith("am");
        let pm = s.endsWith("pm");
        s = s.replace(/am|pm/g, "").trim();
        const [h, m] = s.split(":").map(Number);
        let hh = h;
        if (pm && h !== 12) hh += 12;
        if (am && h === 12) hh = 0;
        return hh * 60 + (m || 0);
    }

    function isSame(a, b) {
        if (!a || !b) return false;
        return a.trim().toLowerCase() === b.trim().toLowerCase();
    }

})();
