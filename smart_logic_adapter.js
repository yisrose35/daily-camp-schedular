
// ============================================================================
// SmartLogicAdapter V35
// - SPECIAL COUNTS IGNORE FALLBACKS
// - USES SPECIFIC SPECIAL NAME (Gameroom, Canteen, etc)
// - LOCKED EVENTS so Core CANNOT overwrite Smart Tile results
// - STRICT ROTATION: Perfect fairness, yesterday penalty, true history awareness
// - Writes pre-history into __smartTileToday for scheduler core
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
                for (let i=0; i<tiles.length; i+=2) {
                    const A = tiles[i];
                    const B = tiles[i+1];
                    const sd = A.smartData || {};

                    if (!B) {
                        jobs.push({
                            division: div,
                            main1: sd.main1,
                            main2: sd.main2,
                            fallbackFor: sd.fallbackFor,
                            fallbackActivity: sd.fallbackActivity,
                            blockA: { startMin: parse(A.startTime), endMin: parse(A.endTime), division: div },
                            blockB: null
                        });
                    } else {
                        jobs.push({
                            division: div,
                            main1: sd.main1,
                            main2: sd.main2,
                            fallbackFor: sd.fallbackFor,
                            fallbackActivity: sd.fallbackActivity,
                            blockA: { startMin: parse(A.startTime), endMin: parse(A.endTime), division: div },
                            blockB: { startMin: parse(B.startTime), endMin: parse(B.endTime), division: div }
                        });
                    }
                }
            });

            return jobs;
        },

        // ---------------------------------------------------------
        // GENERATE PERFECTLY FAIR ASSIGNMENTS (V35)
        // ---------------------------------------------------------
        generateAssignments(bunks, job, historical={}, specialNames=[], activityProps={}, masterFields=[], dailyFieldAvailability={}, yesterdayHistory={}) {

            const main1 = job.main1.trim();
            const main2 = job.main2.trim();
            const fbAct = job.fallbackActivity || "Sports";

            // Identify the Special Act (LIMITED capacity)
            const fbFor = job.fallbackFor || "";
            let specialAct, openAct;

            if (isSame(main1, fbFor)) {
                specialAct = main1; openAct = main2;
            } else if (isSame(main2, fbFor)) {
                specialAct = main2; openAct = main1;
            } else {
                // Default
                specialAct = main1;
                openAct = main2;
            }

            // ---------------------------------------------------------
            // Yesterday Check (V35: specific special)
            // ---------------------------------------------------------
            const allSpecials = window.getGlobalSpecialActivities ? window.getGlobalSpecialActivities() : [];

            function playedYesterday(bunk) {
                const sched = yesterdayHistory.schedule?.[bunk] || [];
                return sched.some(e => {
                    const act = (e?._activity || "").toLowerCase();
                    return allSpecials.some(s => s.name.toLowerCase() === act);
                }) ? 1 : 0;
            }

            // ---------------------------------------------------------
            // Category History — fallback DOES NOT count
            // ---------------------------------------------------------
            function getCategoryHistory(bunk, actName) {
                if (!historical[bunk]) return 0;
                let sum = 0;

                const lower = actName.toLowerCase();

                // Count ONLY true special names
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

            // ---------------------------------------------------------
            // Total History (fairness)
            // ---------------------------------------------------------
            function getTotalHistory(bunk) {
                if (!historical[bunk]) return 0;
                return Object.values(historical[bunk]).reduce((a,b)=>a+b,0);
            }

            // ---------------------------------------------------------
            // Sort bunks by strict fairness
            // ---------------------------------------------------------
            const sorted = [...bunks].sort((a,b) => {
                const A = getCategoryHistory(a, specialAct);
                const B = getCategoryHistory(b, specialAct);
                if (A !== B) return A-B;

                const YA = playedYesterday(a);
                const YB = playedYesterday(b);
                if (YA !== YB) return YA - YB;

                const TA = getTotalHistory(a);
                const TB = getTotalHistory(b);
                if (TA !== TB) return TA-TB;

                return Math.random() - 0.5;
            });

            // ---------------------------------------------------------
            // Determine Capacity of Special for the block
            // ---------------------------------------------------------
            function calcCap(startMin, endMin) {
                // Specific special
                const sp = allSpecials.find(s => isSame(s.name, specialAct));
                if (!sp) return 2; // default

                // sharable capacity logic
                if (sp.sharableWith?.capacity) return parseInt(sp.sharableWith.capacity);
                if (sp.sharableWith?.type === 'not_sharable') return 1;
                if (sp.sharableWith?.type === 'all') return 2;
                if (sp.sharable) return 2;
                return 1;
            }

            // ---------------------------------------------------------
            // Block A assignment
            // ---------------------------------------------------------
            const capA = calcCap(job.blockA.startMin, job.blockA.endMin);
            let countA = 0;
            const block1 = {};
            const winnersA = new Set();

            sorted.forEach(bunk => {
                if (countA < capA) {
                    block1[bunk] = specialAct;
                    winnersA.add(bunk);
                    countA++;
                } else {
                    block1[bunk] = openAct;
                }
            });

            // ---------------------------------------------------------
            // Block B assignment
            // ---------------------------------------------------------
            const block2 = {};
            if (job.blockB) {
                const capB = calcCap(job.blockB.startMin, job.blockB.endMin);
                let countB = 0;

                const candidates = sorted.filter(b => !winnersA.has(b));
                const forcedOpen = [...winnersA];

                forcedOpen.forEach(b => block2[b] = openAct);

                candidates.forEach(b => {
                    if (countB < capB) {
                        block2[b] = specialAct;
                        countB++;
                    } else {
                        block2[b] = fbAct; // fallback does NOT count in fairness
                    }
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
            // Pre-save history for today so Core Pass 5 can use it
            // ---------------------------------------------------------
            window.__smartTileToday = window.__smartTileToday || {};
            window.__smartTileToday[job.division] = {
                specialAct,
                block1,
                block2
            };

            // Final return
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
        s = s.replace(/am|pm/g,"").trim();
        const [h,m] = s.split(":").map(Number);
        let hh=h;
        if (pm && h!==12) hh+=12;
        if (am && h===12) hh=0;
        return hh*60 + (m||0);
    }
    function isSame(a,b){
        if(!a||!b) return false;
        return a.trim().toLowerCase()===b.trim().toLowerCase();
    }

})();
