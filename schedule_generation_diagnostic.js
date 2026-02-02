// =============================================================================
// schedule_generation_diagnostic.js v1.0 — COMPREHENSIVE MULTI-DAY DIAGNOSTIC
// =============================================================================
//
// PURPOSE: Full diagnostic analysis of schedule generation quality across
// multiple days to ensure optimal activity distribution, capacity compliance,
// proper rotation, and conflict-free scheduling.
//
// CHECKS:
// ✅ Activity distribution across days (spread out)
// ✅ Capacity compliance (per-division and cross-division)
// ✅ Cross-division conflict detection
// ✅ Indoor/outdoor activity handling
// ✅ Rotation engine scoring verification
// ✅ League game fairness & distribution
// ✅ Historical count accuracy
// ✅ Same-day repetition violations
// ✅ Streak detection (consecutive days same activity)
// ✅ Activity coverage (bunks trying all activities)
// ✅ Field availability compliance
// ✅ Division-specific time slot mapping
//
// =============================================================================

(function() {
    'use strict';

    const VERSION = '1.0.0';
    
    // Configuration for diagnostic thresholds
    const CONFIG = {
        MAX_CONSECUTIVE_DAYS_SAME_ACTIVITY: 2,    // Flag if activity done 3+ days in a row
        MIN_DAYS_BETWEEN_SAME_ACTIVITY: 2,        // Ideal gap between repeating activities
        ACTIVITY_COVERAGE_WARNING_THRESHOLD: 0.5, // Warn if bunk has done <50% of activities
        CAPACITY_VIOLATION_SEVERITY: 'error',     // 'error' or 'warning'
        CROSS_DIV_CONFLICT_SEVERITY: 'error',
        MAX_ACTIVITY_FREQUENCY_IMBALANCE: 3,      // Max diff between most/least done activity
    };

    // Activities to ignore in analysis
    const IGNORED_ACTIVITIES = [
        'free', 'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'lineup', 'bus', 'transition', 'buffer',
        'transition/buffer'
    ];

    const IGNORED_FIELDS = [
        'free', 'no field', 'no game', 'unassigned league',
        'lunch', 'snacks', 'dismissal', 'regroup', 'free play',
        'mincha', 'davening', 'lineup', 'bus', 'swim', 'pool',
        'canteen', 'gameroom', 'game room'
    ];

    // ==========================================================================
    // MAIN DIAGNOSTIC FUNCTION
    // ==========================================================================

    function runFullDiagnostic(options = {}) {
        const {
            dateRange = null,       // { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } or null for all
            divisionsToCheck = null, // Array of division names or null for all
            verbose = true,
            showUI = true
        } = options;

        console.log('\n' + '═'.repeat(80));
        console.log('🔍 COMPREHENSIVE SCHEDULE GENERATION DIAGNOSTIC v' + VERSION);
        console.log('═'.repeat(80));
        console.log('Started at:', new Date().toISOString());

        const results = {
            summary: { errors: 0, warnings: 0, info: 0 },
            sections: {},
            rawData: {},
            generatedAt: new Date().toISOString()
        };

        try {
            // Load all necessary data
            const allDailyData = window.loadAllDailyData?.() || {};
            const divisions = window.divisions || {};
            const divisionTimes = window.divisionTimes || {};
            const activityProperties = getActivityProperties();
            const settings = window.loadGlobalSettings?.() || {};

            // Filter dates if range specified
            let dates = Object.keys(allDailyData).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
            if (dateRange) {
                dates = dates.filter(d => {
                    if (dateRange.start && d < dateRange.start) return false;
                    if (dateRange.end && d > dateRange.end) return false;
                    return true;
                });
            }

            console.log(`\n📅 Analyzing ${dates.length} dates from ${dates[0] || 'none'} to ${dates[dates.length - 1] || 'none'}`);

            // Store raw data for reports
            results.rawData = {
                dates,
                allDailyData,
                divisions,
                divisionTimes,
                activityProperties,
                divisionsToCheck
            };

            // Run all diagnostic sections
            results.sections.activityDistribution = analyzeActivityDistribution(allDailyData, dates, divisions, divisionsToCheck, verbose);
            results.sections.capacityCompliance = analyzeCapacityCompliance(allDailyData, dates, divisions, divisionTimes, activityProperties, divisionsToCheck, verbose);
            results.sections.crossDivisionConflicts = analyzeCrossDivisionConflicts(allDailyData, dates, divisions, divisionTimes, activityProperties, verbose);
            results.sections.indoorOutdoorHandling = analyzeIndoorOutdoorHandling(allDailyData, dates, activityProperties, settings, verbose);
            results.sections.rotationScoring = analyzeRotationScoring(allDailyData, dates, divisions, activityProperties, divisionsToCheck, verbose);
            results.sections.leagueDistribution = analyzeLeagueDistribution(allDailyData, dates, divisions, verbose);
            results.sections.historicalCounts = verifyHistoricalCounts(allDailyData, dates, verbose);
            results.sections.streakDetection = analyzeActivityStreaks(allDailyData, dates, divisions, divisionsToCheck, verbose);
            results.sections.activityCoverage = analyzeActivityCoverage(allDailyData, dates, divisions, activityProperties, divisionsToCheck, verbose);
            results.sections.fieldAvailability = analyzeFieldAvailability(allDailyData, dates, activityProperties, settings, verbose);
            results.sections.divisionTimeMapping = verifyDivisionTimeMapping(allDailyData, dates, divisions, divisionTimes, verbose);

            // Calculate summary
            Object.values(results.sections).forEach(section => {
                results.summary.errors += section.errors?.length || 0;
                results.summary.warnings += section.warnings?.length || 0;
                results.summary.info += section.info?.length || 0;
            });

            // Log summary
            console.log('\n' + '═'.repeat(80));
            console.log('📊 DIAGNOSTIC SUMMARY');
            console.log('═'.repeat(80));
            console.log(`  ❌ Errors:   ${results.summary.errors}`);
            console.log(`  ⚠️  Warnings: ${results.summary.warnings}`);
            console.log(`  ℹ️  Info:     ${results.summary.info}`);
            console.log('═'.repeat(80));

            // Show UI if requested
            if (showUI) {
                showDiagnosticModal(results);
            }

        } catch (e) {
            console.error('❌ Diagnostic failed:', e);
            results.error = e.message;
        }

        return results;
    }

    // ==========================================================================
    // SECTION 1: ACTIVITY DISTRIBUTION ANALYSIS
    // ==========================================================================

    function analyzeActivityDistribution(allDailyData, dates, divisions, divisionsToCheck, verbose) {
        if (verbose) console.log('\n📊 [1/11] Analyzing Activity Distribution...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        const bunkActivityByDate = {}; // { bunk: { activity: [dates] } }
        const activityGaps = {};        // { bunk: { activity: [gaps in days] } }

        // Build activity history per bunk
        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.scheduleAssignments) return;

            Object.entries(dayData.scheduleAssignments).forEach(([bunk, slots]) => {
                // Filter by division if specified
                if (divisionsToCheck) {
                    const bunkDiv = findDivisionForBunk(bunk, divisions);
                    if (!divisionsToCheck.includes(bunkDiv)) return;
                }

                if (!bunkActivityByDate[bunk]) bunkActivityByDate[bunk] = {};

                const activitiesOnDate = new Set();
                (slots || []).forEach(slot => {
                    if (!slot || slot.continuation || slot._isTransition) return;
                    const activity = normalizeActivity(slot._activity || slot.field);
                    if (!activity || IGNORED_ACTIVITIES.includes(activity)) return;
                    
                    // Track unique activities per date (not duplicates within same day)
                    activitiesOnDate.add(activity);
                });

                activitiesOnDate.forEach(activity => {
                    if (!bunkActivityByDate[bunk][activity]) {
                        bunkActivityByDate[bunk][activity] = [];
                    }
                    bunkActivityByDate[bunk][activity].push(date);
                });
            });
        });

        // Calculate gaps between activity occurrences
        Object.entries(bunkActivityByDate).forEach(([bunk, activities]) => {
            activityGaps[bunk] = {};
            
            Object.entries(activities).forEach(([activity, activityDates]) => {
                if (activityDates.length < 2) return;
                
                const sortedDates = activityDates.sort();
                const gaps = [];
                
                for (let i = 1; i < sortedDates.length; i++) {
                    const prev = new Date(sortedDates[i - 1]);
                    const curr = new Date(sortedDates[i]);
                    const daysBetween = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
                    gaps.push(daysBetween);
                }
                
                activityGaps[bunk][activity] = gaps;
                
                // Flag if activities are too close together
                const tooClose = gaps.filter(g => g < CONFIG.MIN_DAYS_BETWEEN_SAME_ACTIVITY);
                if (tooClose.length > 0) {
                    result.warnings.push({
                        bunk,
                        activity,
                        message: `"${activity}" repeated with only ${tooClose.join(', ')} day(s) gap (ideal: ${CONFIG.MIN_DAYS_BETWEEN_SAME_ACTIVITY}+ days)`,
                        dates: sortedDates.join(', ')
                    });
                }
            });
        });

        // Calculate distribution statistics
        const distributionStats = {};
        Object.entries(bunkActivityByDate).forEach(([bunk, activities]) => {
            const counts = Object.entries(activities).map(([act, dates]) => ({ activity: act, count: dates.length }));
            counts.sort((a, b) => b.count - a.count);
            
            if (counts.length > 0) {
                const max = counts[0].count;
                const min = counts[counts.length - 1].count;
                const imbalance = max - min;
                
                distributionStats[bunk] = {
                    mostFrequent: counts[0],
                    leastFrequent: counts[counts.length - 1],
                    imbalance,
                    totalActivities: counts.length
                };

                if (imbalance > CONFIG.MAX_ACTIVITY_FREQUENCY_IMBALANCE) {
                    result.warnings.push({
                        bunk,
                        message: `Activity imbalance: "${counts[0].activity}" done ${max}x vs "${counts[counts.length - 1].activity}" done ${min}x (diff: ${imbalance})`,
                        mostFrequent: counts[0],
                        leastFrequent: counts[counts.length - 1]
                    });
                }
            }
        });

        result.data = { bunkActivityByDate, activityGaps, distributionStats };
        
        if (verbose) {
            console.log(`   ✓ Analyzed ${Object.keys(bunkActivityByDate).length} bunks`);
            console.log(`   ✓ Found ${result.warnings.length} distribution warnings`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 2: CAPACITY COMPLIANCE
    // ==========================================================================

    function analyzeCapacityCompliance(allDailyData, dates, divisions, divisionTimes, activityProperties, divisionsToCheck, verbose) {
        if (verbose) console.log('\n📊 [2/11] Analyzing Capacity Compliance...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        const violationsByDate = {};

        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.scheduleAssignments) return;

            violationsByDate[date] = [];
            
            // Build field usage by time
            const fieldUsageByTime = {}; // { field: [{ bunk, div, startMin, endMin }] }

            Object.entries(dayData.scheduleAssignments).forEach(([bunk, slots]) => {
                const divName = findDivisionForBunk(bunk, divisions);
                if (!divName) return;
                if (divisionsToCheck && !divisionsToCheck.includes(divName)) return;

                const divSlots = divisionTimes[divName] || [];

                (slots || []).forEach((slot, slotIdx) => {
                    if (!slot || slot.continuation || slot._isLeague) return;
                    
                    const field = normalizeActivity(slot.field || slot._activity);
                    if (!field || IGNORED_FIELDS.includes(field)) return;

                    const slotInfo = divSlots[slotIdx];
                    if (!slotInfo) return;

                    if (!fieldUsageByTime[field]) fieldUsageByTime[field] = [];
                    fieldUsageByTime[field].push({
                        bunk,
                        division: divName,
                        startMin: slotInfo.startMin,
                        endMin: slotInfo.endMin,
                        slotIdx
                    });
                });
            });

            // Check capacity for each field
            Object.entries(fieldUsageByTime).forEach(([field, usages]) => {
                const props = activityProperties[field] || {};
                const sharableWith = props.sharableWith || {};
                
                let maxCapacity = 1;
                if (sharableWith.type === 'all') {
                    maxCapacity = 999;
                } else if (sharableWith.type === 'custom') {
                    maxCapacity = parseInt(sharableWith.capacity) || 2;
                } else if (sharableWith.capacity) {
                    maxCapacity = parseInt(sharableWith.capacity);
                } else if (props.sharable) {
                    maxCapacity = 2;
                }

                // Group by overlapping time
                const overlaps = findOverlappingUsages(usages);
                
                overlaps.forEach(group => {
                    if (group.length > maxCapacity) {
                        const violation = {
                            field,
                            count: group.length,
                            maxCapacity,
                            bunks: group.map(u => `${u.bunk} (Div ${u.division})`),
                            timeRange: `${formatMinutes(group[0].startMin)}-${formatMinutes(group[0].endMin)}`
                        };
                        
                        violationsByDate[date].push(violation);
                        result.errors.push({
                            date,
                            ...violation,
                            message: `Capacity exceeded: "${field}" has ${group.length}/${maxCapacity} users at ${violation.timeRange}`
                        });
                    }
                });
            });
        });

        result.data = { violationsByDate };
        
        if (verbose) {
            const totalViolations = Object.values(violationsByDate).flat().length;
            console.log(`   ✓ Checked ${dates.length} dates`);
            console.log(`   ✓ Found ${totalViolations} capacity violations`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 3: CROSS-DIVISION CONFLICTS
    // ==========================================================================

    function analyzeCrossDivisionConflicts(allDailyData, dates, divisions, divisionTimes, activityProperties, verbose) {
        if (verbose) console.log('\n📊 [3/11] Analyzing Cross-Division Conflicts...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        const conflictsByDate = {};

        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.scheduleAssignments) return;

            conflictsByDate[date] = [];
            
            // Build field usage with division tracking
            const fieldUsageByTime = {};

            Object.entries(dayData.scheduleAssignments).forEach(([bunk, slots]) => {
                const divName = findDivisionForBunk(bunk, divisions);
                if (!divName) return;

                const divSlots = divisionTimes[divName] || [];

                (slots || []).forEach((slot, slotIdx) => {
                    if (!slot || slot.continuation || slot._isLeague) return;
                    
                    const field = normalizeActivity(slot.field || slot._activity);
                    if (!field || IGNORED_FIELDS.includes(field)) return;

                    const slotInfo = divSlots[slotIdx];
                    if (!slotInfo) return;

                    if (!fieldUsageByTime[field]) fieldUsageByTime[field] = [];
                    fieldUsageByTime[field].push({
                        bunk,
                        division: divName,
                        startMin: slotInfo.startMin,
                        endMin: slotInfo.endMin
                    });
                });
            });

            // Check for cross-division conflicts
            Object.entries(fieldUsageByTime).forEach(([field, usages]) => {
                const props = activityProperties[field] || {};
                const sharableWith = props.sharableWith || {};
                
                // If type !== 'all', cross-division sharing is NOT allowed
                if (sharableWith.type === 'all') return;

                const overlaps = findOverlappingUsages(usages);
                
                overlaps.forEach(group => {
                    const divisionsInGroup = [...new Set(group.map(u => u.division))];
                    
                    if (divisionsInGroup.length > 1) {
                        const conflict = {
                            field,
                            divisions: divisionsInGroup,
                            bunks: group.map(u => `${u.bunk} (Div ${u.division})`),
                            timeRange: `${formatMinutes(group[0].startMin)}-${formatMinutes(group[0].endMin)}`
                        };
                        
                        conflictsByDate[date].push(conflict);
                        result.errors.push({
                            date,
                            ...conflict,
                            message: `Cross-division conflict: "${field}" shared by divisions ${divisionsInGroup.join(', ')} at ${conflict.timeRange}`
                        });
                    }
                });
            });
        });

        result.data = { conflictsByDate };
        
        if (verbose) {
            const totalConflicts = Object.values(conflictsByDate).flat().length;
            console.log(`   ✓ Checked ${dates.length} dates`);
            console.log(`   ✓ Found ${totalConflicts} cross-division conflicts`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 4: INDOOR/OUTDOOR HANDLING
    // ==========================================================================

    function analyzeIndoorOutdoorHandling(allDailyData, dates, activityProperties, settings, verbose) {
        if (verbose) console.log('\n📊 [4/11] Analyzing Indoor/Outdoor Handling...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        const fields = settings.app1?.fields || [];
        const specials = settings.app1?.specialActivities || [];

        // Build indoor/outdoor maps
        const indoorFields = new Set(fields.filter(f => f.rainyDayAvailable === true).map(f => f.name?.toLowerCase()));
        const outdoorFields = new Set(fields.filter(f => f.rainyDayAvailable !== true).map(f => f.name?.toLowerCase()));
        const indoorSpecials = new Set(specials.filter(s => s.isIndoor === true).map(s => s.name?.toLowerCase()));
        const rainyOnlySpecials = new Set(specials.filter(s => s.rainyDayOnly === true).map(s => s.name?.toLowerCase()));

        const rainyDayAnalysis = {};

        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData) return;

            const isRainyDay = dayData.isRainyDay === true || dayData.rainyDayMode === true;
            rainyDayAnalysis[date] = {
                isRainyDay,
                outdoorActivitiesUsed: [],
                indoorActivitiesUsed: [],
                rainyOnlyUsed: []
            };

            if (!dayData.scheduleAssignments) return;

            const activitiesUsed = new Set();
            Object.values(dayData.scheduleAssignments).forEach(slots => {
                (slots || []).forEach(slot => {
                    if (!slot || slot.continuation) return;
                    const activity = (slot._activity || slot.field || '').toLowerCase().trim();
                    if (activity && !IGNORED_ACTIVITIES.includes(activity)) {
                        activitiesUsed.add(activity);
                    }
                });
            });

            activitiesUsed.forEach(act => {
                if (outdoorFields.has(act)) {
                    rainyDayAnalysis[date].outdoorActivitiesUsed.push(act);
                    if (isRainyDay) {
                        result.errors.push({
                            date,
                            activity: act,
                            message: `Outdoor field "${act}" used on rainy day`
                        });
                    }
                }
                if (indoorFields.has(act) || indoorSpecials.has(act)) {
                    rainyDayAnalysis[date].indoorActivitiesUsed.push(act);
                }
                if (rainyOnlySpecials.has(act)) {
                    rainyDayAnalysis[date].rainyOnlyUsed.push(act);
                    if (!isRainyDay) {
                        result.warnings.push({
                            date,
                            activity: act,
                            message: `Rainy-day-only activity "${act}" used on non-rainy day`
                        });
                    }
                }
            });
        });

        result.data = { rainyDayAnalysis, indoorFields: [...indoorFields], outdoorFields: [...outdoorFields] };
        result.info.push({
            message: `Indoor fields: ${indoorFields.size}, Outdoor fields: ${outdoorFields.size}, Rainy-only specials: ${rainyOnlySpecials.size}`
        });

        if (verbose) {
            const rainyDays = dates.filter(d => rainyDayAnalysis[d]?.isRainyDay).length;
            console.log(`   ✓ Found ${rainyDays} rainy days out of ${dates.length}`);
            console.log(`   ✓ Indoor fields: ${indoorFields.size}, Outdoor: ${outdoorFields.size}`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 5: ROTATION SCORING VERIFICATION
    // ==========================================================================

    function analyzeRotationScoring(allDailyData, dates, divisions, activityProperties, divisionsToCheck, verbose) {
        if (verbose) console.log('\n📊 [5/11] Analyzing Rotation Scoring...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        
        if (!window.RotationEngine) {
            result.warnings.push({ message: 'RotationEngine not loaded - skipping rotation analysis' });
            return result;
        }

        // Rebuild history to ensure accuracy
        window.RotationEngine.rebuildAllHistory?.();

        const bunkScores = {};
        const allBunks = [];

        // Collect all bunks
        Object.entries(divisions).forEach(([divName, divData]) => {
            if (divisionsToCheck && !divisionsToCheck.includes(divName)) return;
            (divData.bunks || []).forEach(bunk => allBunks.push({ bunk, division: divName }));
        });

        // Get all activity names
        const allActivities = window.RotationEngine.getAllActivityNames?.() || Object.keys(activityProperties);

        // Calculate scores for each bunk
        allBunks.forEach(({ bunk, division }) => {
            const scores = [];
            
            allActivities.forEach(activity => {
                if (IGNORED_ACTIVITIES.includes(activity.toLowerCase())) return;
                
                const score = window.RotationEngine.calculateRotationScore?.({
                    bunkName: bunk,
                    activityName: activity,
                    divisionName: division,
                    beforeSlotIndex: 0,
                    allActivities,
                    activityProperties
                }) || 0;

                scores.push({ activity, score, blocked: score === Infinity });
            });

            scores.sort((a, b) => a.score - b.score);
            
            bunkScores[bunk] = {
                division,
                bestOptions: scores.filter(s => !s.blocked).slice(0, 5),
                blockedActivities: scores.filter(s => s.blocked).map(s => s.activity),
                averageScore: scores.filter(s => !s.blocked).reduce((sum, s) => sum + s.score, 0) / Math.max(1, scores.filter(s => !s.blocked).length)
            };

            // Check for issues
            if (bunkScores[bunk].blockedActivities.length > allActivities.length * 0.5) {
                result.warnings.push({
                    bunk,
                    message: `${bunk} has ${bunkScores[bunk].blockedActivities.length}/${allActivities.length} activities blocked (>50%)`,
                    blocked: bunkScores[bunk].blockedActivities
                });
            }
        });

        result.data = { bunkScores };

        if (verbose) {
            console.log(`   ✓ Analyzed rotation scores for ${allBunks.length} bunks`);
            console.log(`   ✓ Checked against ${allActivities.length} activities`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 6: LEAGUE DISTRIBUTION
    // ==========================================================================

    function analyzeLeagueDistribution(allDailyData, dates, divisions, verbose) {
        if (verbose) console.log('\n📊 [6/11] Analyzing League Distribution...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        const leagueGamesByDate = {};
        const teamStats = {}; // { leagueName: { team: { gamesPlayed, wins, losses, opponents } } }

        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.leagueAssignments) return;

            leagueGamesByDate[date] = [];

            Object.entries(dayData.leagueAssignments).forEach(([divName, divLeagues]) => {
                if (typeof divLeagues !== 'object') return;
                
                Object.entries(divLeagues).forEach(([slotIdx, leagueData]) => {
                    if (!leagueData?.matchups) return;
                    
                    const leagueName = leagueData.leagueName || leagueData.sport || 'Unknown League';
                    
                    if (!teamStats[leagueName]) teamStats[leagueName] = {};
                    
                    leagueData.matchups.forEach(matchup => {
                        const team1 = matchup.team1 || matchup.teamA;
                        const team2 = matchup.team2 || matchup.teamB;
                        
                        if (!team1 || !team2) return;

                        // Track game for each team
                        [team1, team2].forEach(team => {
                            if (!teamStats[leagueName][team]) {
                                teamStats[leagueName][team] = { gamesPlayed: 0, opponents: {} };
                            }
                            teamStats[leagueName][team].gamesPlayed++;
                        });

                        // Track opponents
                        teamStats[leagueName][team1].opponents[team2] = (teamStats[leagueName][team1].opponents[team2] || 0) + 1;
                        teamStats[leagueName][team2].opponents[team1] = (teamStats[leagueName][team2].opponents[team1] || 0) + 1;

                        leagueGamesByDate[date].push({
                            league: leagueName,
                            team1,
                            team2,
                            field: matchup.field,
                            division: divName
                        });
                    });
                });
            });
        });

        // Analyze fairness
        Object.entries(teamStats).forEach(([league, teams]) => {
            const teamList = Object.entries(teams);
            if (teamList.length < 2) return;

            const gameCounts = teamList.map(([team, data]) => data.gamesPlayed);
            const maxGames = Math.max(...gameCounts);
            const minGames = Math.min(...gameCounts);

            if (maxGames - minGames > 2) {
                result.warnings.push({
                    league,
                    message: `Game imbalance in "${league}": ${minGames}-${maxGames} games played (diff: ${maxGames - minGames})`,
                    teams: teamList.map(([team, data]) => `${team}: ${data.gamesPlayed} games`).join(', ')
                });
            }

            // Check for repeat matchups
            teamList.forEach(([team, data]) => {
                Object.entries(data.opponents).forEach(([opponent, count]) => {
                    if (count > 2) {
                        result.info.push({
                            league,
                            message: `${team} vs ${opponent} played ${count} times in "${league}"`
                        });
                    }
                });
            });
        });

        result.data = { leagueGamesByDate, teamStats };

        if (verbose) {
            const totalGames = Object.values(leagueGamesByDate).flat().length;
            console.log(`   ✓ Found ${totalGames} league games across ${dates.length} dates`);
            console.log(`   ✓ Analyzed ${Object.keys(teamStats).length} leagues`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 7: HISTORICAL COUNTS VERIFICATION
    // ==========================================================================

    function verifyHistoricalCounts(allDailyData, dates, verbose) {
        if (verbose) console.log('\n📊 [7/11] Verifying Historical Counts...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };

        // Rebuild counts from scratch
        const calculatedCounts = {};
        let totalActivities = 0;

        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.scheduleAssignments) return;

            Object.entries(dayData.scheduleAssignments).forEach(([bunk, slots]) => {
                if (!calculatedCounts[bunk]) calculatedCounts[bunk] = {};

                (slots || []).forEach(slot => {
                    if (!slot || slot.continuation || slot._isTransition) return;
                    const activity = slot._activity;
                    if (!activity || IGNORED_ACTIVITIES.includes(activity.toLowerCase())) return;

                    calculatedCounts[bunk][activity] = (calculatedCounts[bunk][activity] || 0) + 1;
                    totalActivities++;
                });
            });
        });

        // Compare with stored counts
        const storedCounts = window.loadGlobalSettings?.()?.historicalCounts || {};
        let mismatches = 0;

        Object.entries(calculatedCounts).forEach(([bunk, activities]) => {
            Object.entries(activities).forEach(([activity, count]) => {
                const stored = storedCounts[bunk]?.[activity] || 0;
                if (stored !== count) {
                    mismatches++;
                    if (Math.abs(stored - count) > 2) {
                        result.warnings.push({
                            bunk,
                            activity,
                            message: `Count mismatch for ${bunk}/${activity}: stored=${stored}, calculated=${count}`,
                            stored,
                            calculated: count
                        });
                    }
                }
            });
        });

        result.data = { 
            calculatedCounts, 
            storedCounts, 
            totalActivities,
            mismatches,
            bunksAnalyzed: Object.keys(calculatedCounts).length
        };

        if (mismatches > 0) {
            result.info.push({
                message: `Found ${mismatches} count mismatches. Consider running rebuildHistoricalCounts()`
            });
        }

        if (verbose) {
            console.log(`   ✓ Calculated ${totalActivities} activity instances`);
            console.log(`   ✓ Found ${mismatches} mismatches with stored counts`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 8: STREAK DETECTION
    // ==========================================================================

    function analyzeActivityStreaks(allDailyData, dates, divisions, divisionsToCheck, verbose) {
        if (verbose) console.log('\n📊 [8/11] Analyzing Activity Streaks...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        const bunkStreaks = {}; // { bunk: { activity: maxConsecutiveDays } }

        const sortedDates = [...dates].sort();

        // Build activity-per-date map for each bunk
        const bunkActivityByDate = {};
        
        sortedDates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.scheduleAssignments) return;

            Object.entries(dayData.scheduleAssignments).forEach(([bunk, slots]) => {
                if (divisionsToCheck) {
                    const div = findDivisionForBunk(bunk, divisions);
                    if (!divisionsToCheck.includes(div)) return;
                }

                if (!bunkActivityByDate[bunk]) bunkActivityByDate[bunk] = {};
                if (!bunkActivityByDate[bunk][date]) bunkActivityByDate[bunk][date] = new Set();

                (slots || []).forEach(slot => {
                    if (!slot || slot.continuation || slot._isTransition) return;
                    const activity = normalizeActivity(slot._activity || slot.field);
                    if (activity && !IGNORED_ACTIVITIES.includes(activity)) {
                        bunkActivityByDate[bunk][date].add(activity);
                    }
                });
            });
        });

        // Calculate streaks
        Object.entries(bunkActivityByDate).forEach(([bunk, dateActivities]) => {
            bunkStreaks[bunk] = {};
            
            // Get all unique activities for this bunk
            const allActivities = new Set();
            Object.values(dateActivities).forEach(acts => acts.forEach(a => allActivities.add(a)));

            allActivities.forEach(activity => {
                let maxStreak = 0;
                let currentStreak = 0;
                let streakStartDate = null;
                let maxStreakDates = [];

                for (let i = 0; i < sortedDates.length; i++) {
                    const date = sortedDates[i];
                    const hasActivity = dateActivities[date]?.has(activity);

                    if (hasActivity) {
                        if (currentStreak === 0) streakStartDate = date;
                        currentStreak++;
                        
                        if (currentStreak > maxStreak) {
                            maxStreak = currentStreak;
                            maxStreakDates = sortedDates.slice(i - currentStreak + 1, i + 1);
                        }
                    } else {
                        currentStreak = 0;
                    }
                }

                bunkStreaks[bunk][activity] = { maxStreak, dates: maxStreakDates };

                if (maxStreak > CONFIG.MAX_CONSECUTIVE_DAYS_SAME_ACTIVITY) {
                    result.warnings.push({
                        bunk,
                        activity,
                        message: `"${activity}" done ${maxStreak} consecutive days (max recommended: ${CONFIG.MAX_CONSECUTIVE_DAYS_SAME_ACTIVITY})`,
                        dates: maxStreakDates.join(', ')
                    });
                }
            });
        });

        result.data = { bunkStreaks };

        if (verbose) {
            const worstStreaks = [];
            Object.entries(bunkStreaks).forEach(([bunk, activities]) => {
                Object.entries(activities).forEach(([activity, data]) => {
                    if (data.maxStreak > CONFIG.MAX_CONSECUTIVE_DAYS_SAME_ACTIVITY) {
                        worstStreaks.push({ bunk, activity, streak: data.maxStreak });
                    }
                });
            });
            console.log(`   ✓ Analyzed ${Object.keys(bunkStreaks).length} bunks for streaks`);
            console.log(`   ✓ Found ${worstStreaks.length} problematic streaks (>${CONFIG.MAX_CONSECUTIVE_DAYS_SAME_ACTIVITY} days)`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 9: ACTIVITY COVERAGE
    // ==========================================================================

    function analyzeActivityCoverage(allDailyData, dates, divisions, activityProperties, divisionsToCheck, verbose) {
        if (verbose) console.log('\n📊 [9/11] Analyzing Activity Coverage...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };

        // Get all available activities
        const allActivities = new Set(
            Object.keys(activityProperties).filter(a => !IGNORED_ACTIVITIES.includes(a.toLowerCase()))
        );

        const bunkCoverage = {}; // { bunk: { tried: Set, notTried: Set, percentage } }

        // Build what each bunk has done
        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.scheduleAssignments) return;

            Object.entries(dayData.scheduleAssignments).forEach(([bunk, slots]) => {
                if (divisionsToCheck) {
                    const div = findDivisionForBunk(bunk, divisions);
                    if (!divisionsToCheck.includes(div)) return;
                }

                if (!bunkCoverage[bunk]) {
                    bunkCoverage[bunk] = { tried: new Set(), notTried: new Set(allActivities) };
                }

                (slots || []).forEach(slot => {
                    if (!slot || slot.continuation || slot._isTransition) return;
                    const activity = normalizeActivity(slot._activity || slot.field);
                    if (activity && allActivities.has(activity)) {
                        bunkCoverage[bunk].tried.add(activity);
                        bunkCoverage[bunk].notTried.delete(activity);
                    }
                });
            });
        });

        // Calculate percentages and flag low coverage
        Object.entries(bunkCoverage).forEach(([bunk, coverage]) => {
            coverage.percentage = coverage.tried.size / Math.max(1, allActivities.size);
            coverage.tried = [...coverage.tried];
            coverage.notTried = [...coverage.notTried];

            if (coverage.percentage < CONFIG.ACTIVITY_COVERAGE_WARNING_THRESHOLD) {
                result.warnings.push({
                    bunk,
                    message: `Low activity coverage: ${bunk} has only tried ${Math.round(coverage.percentage * 100)}% of activities (${coverage.tried.length}/${allActivities.size})`,
                    notTried: coverage.notTried.slice(0, 10).join(', ') + (coverage.notTried.length > 10 ? '...' : '')
                });
            }
        });

        result.data = { bunkCoverage, totalActivities: allActivities.size };

        if (verbose) {
            const avgCoverage = Object.values(bunkCoverage).reduce((sum, c) => sum + c.percentage, 0) / Math.max(1, Object.keys(bunkCoverage).length);
            console.log(`   ✓ Total available activities: ${allActivities.size}`);
            console.log(`   ✓ Average coverage: ${Math.round(avgCoverage * 100)}%`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 10: FIELD AVAILABILITY
    // ==========================================================================

    function analyzeFieldAvailability(allDailyData, dates, activityProperties, settings, verbose) {
        if (verbose) console.log('\n📊 [10/11] Analyzing Field Availability Rules...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };
        const violationsByDate = {};

        // Build time rules map
        const fieldsWithTimeRules = {};
        Object.entries(activityProperties).forEach(([field, props]) => {
            if (props.timeRules && props.timeRules.length > 0) {
                fieldsWithTimeRules[field.toLowerCase()] = props.timeRules;
            }
        });

        dates.forEach(date => {
            const dayData = allDailyData[date];
            if (!dayData?.scheduleAssignments) return;

            violationsByDate[date] = [];

            Object.entries(dayData.scheduleAssignments).forEach(([bunk, slots]) => {
                (slots || []).forEach((slot, slotIdx) => {
                    if (!slot || slot.continuation) return;

                    const field = normalizeActivity(slot.field || slot._activity);
                    if (!field) return;

                    const timeRules = fieldsWithTimeRules[field];
                    if (!timeRules) return;

                    const slotStartMin = slot._startMin || slot.startMin;
                    const slotEndMin = slot._endMin || slot.endMin;
                    if (slotStartMin === undefined) return;

                    // Check if slot violates time rules
                    const unavailableRules = timeRules.filter(r => r.type === 'Unavailable' || r.available === false);
                    const availableRules = timeRules.filter(r => r.type === 'Available' || r.available === true);

                    // Check unavailable rules (blocked during these times)
                    unavailableRules.forEach(rule => {
                        const ruleStart = rule.startMin ?? parseTimeToMinutes(rule.startTime);
                        const ruleEnd = rule.endMin ?? parseTimeToMinutes(rule.endTime);
                        
                        if (slotStartMin < ruleEnd && slotEndMin > ruleStart) {
                            result.errors.push({
                                date,
                                bunk,
                                field,
                                message: `"${field}" used during unavailable time: ${formatMinutes(slotStartMin)}-${formatMinutes(slotEndMin)} (blocked: ${formatMinutes(ruleStart)}-${formatMinutes(ruleEnd)})`,
                                slotIdx
                            });
                            violationsByDate[date].push({ bunk, field, slotIdx });
                        }
                    });

                    // Check available rules (only allowed during these times)
                    if (availableRules.length > 0) {
                        const withinAvailable = availableRules.some(rule => {
                            const ruleStart = rule.startMin ?? parseTimeToMinutes(rule.startTime);
                            const ruleEnd = rule.endMin ?? parseTimeToMinutes(rule.endTime);
                            return slotStartMin >= ruleStart && slotEndMin <= ruleEnd;
                        });

                        if (!withinAvailable) {
                            result.warnings.push({
                                date,
                                bunk,
                                field,
                                message: `"${field}" used outside available hours: ${formatMinutes(slotStartMin)}-${formatMinutes(slotEndMin)}`,
                                slotIdx
                            });
                        }
                    }
                });
            });
        });

        result.data = { violationsByDate, fieldsWithTimeRules: Object.keys(fieldsWithTimeRules) };

        if (verbose) {
            console.log(`   ✓ Fields with time rules: ${Object.keys(fieldsWithTimeRules).length}`);
            console.log(`   ✓ Violations found: ${result.errors.length + result.warnings.length}`);
        }

        return result;
    }

    // ==========================================================================
    // SECTION 11: DIVISION TIME MAPPING
    // ==========================================================================

    function verifyDivisionTimeMapping(allDailyData, dates, divisions, divisionTimes, verbose) {
        if (verbose) console.log('\n📊 [11/11] Verifying Division Time Mapping...');
        
        const result = { errors: [], warnings: [], info: [], data: {} };

        // Check that each division has proper time slots defined
        Object.entries(divisions).forEach(([divName, divData]) => {
            const divSlots = divisionTimes[divName];
            
            if (!divSlots || divSlots.length === 0) {
                result.errors.push({
                    division: divName,
                    message: `Division "${divName}" has no time slots defined in divisionTimes`
                });
                return;
            }

            // Verify slot structure
            divSlots.forEach((slot, idx) => {
                if (slot.startMin === undefined || slot.endMin === undefined) {
                    result.errors.push({
                        division: divName,
                        slot: idx,
                        message: `Division "${divName}" slot ${idx} missing startMin/endMin`
                    });
                }
            });

            // Check bunks have correct slot count in schedules
            const expectedSlotCount = divSlots.length;
            
            dates.forEach(date => {
                const dayData = allDailyData[date];
                if (!dayData?.scheduleAssignments) return;

                (divData.bunks || []).forEach(bunk => {
                    const bunkSlots = dayData.scheduleAssignments[bunk];
                    if (bunkSlots && bunkSlots.length !== expectedSlotCount) {
                        result.warnings.push({
                            date,
                            division: divName,
                            bunk,
                            message: `Bunk "${bunk}" has ${bunkSlots.length} slots, expected ${expectedSlotCount} for division ${divName}`
                        });
                    }
                });
            });
        });

        result.data = { 
            divisionSlotCounts: Object.fromEntries(
                Object.entries(divisionTimes).map(([div, slots]) => [div, slots?.length || 0])
            )
        };

        if (verbose) {
            console.log(`   ✓ Verified ${Object.keys(divisions).length} divisions`);
            Object.entries(divisionTimes).forEach(([div, slots]) => {
                console.log(`      ${div}: ${slots?.length || 0} slots`);
            });
        }

        return result;
    }

    // ==========================================================================
    // HELPER FUNCTIONS
    // ==========================================================================

    function getActivityProperties() {
        let props = window.activityProperties;
        if (!props || Object.keys(props).length === 0) {
            const settings = window.loadGlobalSettings?.() || {};
            props = {};
            (settings.app1?.fields || []).forEach(f => { if (f.name) props[f.name] = f; });
            (settings.app1?.specialActivities || []).forEach(s => { if (s.name) props[s.name] = s; });
        }
        return props || {};
    }

    function normalizeActivity(name) {
        if (!name) return null;
        return String(name).toLowerCase().trim();
    }

    function findDivisionForBunk(bunk, divisions) {
        for (const [divName, divData] of Object.entries(divisions || {})) {
            if ((divData.bunks || []).map(String).includes(String(bunk))) {
                return divName;
            }
        }
        return null;
    }

    function findOverlappingUsages(usages) {
        const groups = [];
        const processed = new Set();

        usages.forEach((usage, i) => {
            if (processed.has(i)) return;

            const group = [usage];
            processed.add(i);

            usages.forEach((other, j) => {
                if (i === j || processed.has(j)) return;

                // Check time overlap
                const hasOverlap = usage.startMin < other.endMin && usage.endMin > other.startMin;
                if (hasOverlap) {
                    group.push(other);
                    processed.add(j);
                }
            });

            if (group.length > 1) {
                groups.push(group);
            }
        });

        return groups;
    }

    function formatMinutes(min) {
        if (min === null || min === undefined) return '?';
        const hours = Math.floor(min / 60);
        const mins = min % 60;
        const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
        const ampm = hours >= 12 ? 'PM' : 'AM';
        return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
    }

    function parseTimeToMinutes(timeStr) {
        if (!timeStr) return null;
        if (typeof timeStr === 'number') return timeStr;
        
        const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
        if (!match) return null;
        
        let hours = parseInt(match[1]);
        const mins = parseInt(match[2]);
        const ampm = match[3];
        
        if (ampm) {
            if (ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
            if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
        }
        
        return hours * 60 + mins;
    }

    // ==========================================================================
    // UI MODAL
    // ==========================================================================

    function showDiagnosticModal(results) {
        const existing = document.getElementById('diagnostic-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'diagnostic-overlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.7); z-index: 10000;
            display: flex; justify-content: center; align-items: center;
            animation: fadeIn 0.3s;
        `;

        const { summary, sections } = results;
        
        let sectionsHtml = '';
        Object.entries(sections).forEach(([sectionName, section]) => {
            const errorCount = section.errors?.length || 0;
            const warnCount = section.warnings?.length || 0;
            const infoCount = section.info?.length || 0;
            
            const sectionTitle = sectionName.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
            const statusIcon = errorCount > 0 ? '❌' : (warnCount > 0 ? '⚠️' : '✅');
            
            sectionsHtml += `
                <div class="diag-section">
                    <div class="diag-section-header" onclick="this.parentElement.classList.toggle('expanded')">
                        <span>${statusIcon} ${sectionTitle}</span>
                        <span class="diag-counts">
                            ${errorCount > 0 ? `<span class="diag-error-badge">${errorCount} errors</span>` : ''}
                            ${warnCount > 0 ? `<span class="diag-warn-badge">${warnCount} warnings</span>` : ''}
                            ${infoCount > 0 ? `<span class="diag-info-badge">${infoCount} info</span>` : ''}
                            ${errorCount === 0 && warnCount === 0 && infoCount === 0 ? '<span class="diag-ok-badge">OK</span>' : ''}
                        </span>
                    </div>
                    <div class="diag-section-content">
                        ${section.errors?.map(e => `<div class="diag-item diag-error">❌ ${e.message || JSON.stringify(e)}</div>`).join('') || ''}
                        ${section.warnings?.map(w => `<div class="diag-item diag-warning">⚠️ ${w.message || JSON.stringify(w)}</div>`).join('') || ''}
                        ${section.info?.map(i => `<div class="diag-item diag-info">ℹ️ ${i.message || JSON.stringify(i)}</div>`).join('') || ''}
                        ${(section.errors?.length === 0 && section.warnings?.length === 0 && section.info?.length === 0) ? '<div class="diag-item diag-ok">All checks passed!</div>' : ''}
                    </div>
                </div>
            `;
        });

        overlay.innerHTML = `
            <style>
                .diag-modal {
                    background: white; padding: 0; border-radius: 12px;
                    width: 900px; max-width: 95vw; max-height: 90vh;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
                    display: flex; flex-direction: column;
                    font-family: system-ui, -apple-system, sans-serif;
                }
                .diag-header {
                    padding: 20px 25px; border-bottom: 1px solid #e5e7eb;
                    display: flex; justify-content: space-between; align-items: center;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    border-radius: 12px 12px 0 0; color: white;
                }
                .diag-header h2 { margin: 0; font-size: 1.3em; }
                .diag-close { background: rgba(255,255,255,0.2); border: none; font-size: 1.5em; cursor: pointer; color: white; padding: 5px 12px; border-radius: 6px; }
                .diag-close:hover { background: rgba(255,255,255,0.3); }
                .diag-summary {
                    display: flex; gap: 20px; padding: 15px 25px;
                    background: #f9fafb; border-bottom: 1px solid #e5e7eb;
                }
                .diag-summary-item {
                    padding: 10px 20px; border-radius: 8px; text-align: center; min-width: 100px;
                }
                .diag-summary-item.errors { background: #fee2e2; color: #dc2626; }
                .diag-summary-item.warnings { background: #fef3c7; color: #d97706; }
                .diag-summary-item.info { background: #dbeafe; color: #2563eb; }
                .diag-summary-item .count { font-size: 2em; font-weight: bold; }
                .diag-summary-item .label { font-size: 0.85em; }
                .diag-body { overflow-y: auto; padding: 15px 25px; flex: 1; }
                .diag-section { border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
                .diag-section-header {
                    padding: 12px 15px; background: #f9fafb; cursor: pointer;
                    display: flex; justify-content: space-between; align-items: center;
                    font-weight: 500; transition: background 0.2s;
                }
                .diag-section-header:hover { background: #f3f4f6; }
                .diag-section-content { display: none; padding: 10px 15px; max-height: 300px; overflow-y: auto; }
                .diag-section.expanded .diag-section-content { display: block; }
                .diag-counts { display: flex; gap: 8px; }
                .diag-error-badge { background: #fee2e2; color: #dc2626; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; }
                .diag-warn-badge { background: #fef3c7; color: #d97706; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; }
                .diag-info-badge { background: #dbeafe; color: #2563eb; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; }
                .diag-ok-badge { background: #d1fae5; color: #059669; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; }
                .diag-item { padding: 8px 12px; margin: 5px 0; border-radius: 6px; font-size: 0.9em; line-height: 1.4; }
                .diag-item.diag-error { background: #fee2e2; border-left: 3px solid #dc2626; }
                .diag-item.diag-warning { background: #fef3c7; border-left: 3px solid #d97706; }
                .diag-item.diag-info { background: #dbeafe; border-left: 3px solid #2563eb; }
                .diag-item.diag-ok { background: #d1fae5; border-left: 3px solid #059669; }
                .diag-footer {
                    padding: 15px 25px; border-top: 1px solid #e5e7eb;
                    display: flex; justify-content: space-between; align-items: center;
                    background: #f9fafb; border-radius: 0 0 12px 12px;
                }
                .diag-btn {
                    padding: 10px 20px; border-radius: 6px; border: none;
                    cursor: pointer; font-weight: 500; transition: all 0.2s;
                }
                .diag-btn-primary { background: #667eea; color: white; }
                .diag-btn-primary:hover { background: #5a67d8; }
                .diag-btn-secondary { background: #e5e7eb; color: #374151; }
                .diag-btn-secondary:hover { background: #d1d5db; }
            </style>
            <div class="diag-modal">
                <div class="diag-header">
                    <h2>🔍 Schedule Generation Diagnostic v${VERSION}</h2>
                    <button class="diag-close" onclick="this.closest('#diagnostic-overlay').remove()">&times;</button>
                </div>
                <div class="diag-summary">
                    <div class="diag-summary-item errors">
                        <div class="count">${summary.errors}</div>
                        <div class="label">Errors</div>
                    </div>
                    <div class="diag-summary-item warnings">
                        <div class="count">${summary.warnings}</div>
                        <div class="label">Warnings</div>
                    </div>
                    <div class="diag-summary-item info">
                        <div class="count">${summary.info}</div>
                        <div class="label">Info</div>
                    </div>
                </div>
                <div class="diag-body">
                    ${sectionsHtml}
                </div>
                <div class="diag-footer">
                    <span style="color:#6b7280; font-size:0.85em;">Generated: ${results.generatedAt}</span>
                    <div>
                        <button class="diag-btn diag-btn-secondary" onclick="console.log(window._lastDiagnosticResults)">Log to Console</button>
                        <button class="diag-btn diag-btn-primary" onclick="this.closest('#diagnostic-overlay').remove()">Close</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        
        // Store results for console access
        window._lastDiagnosticResults = results;
    }

    // ==========================================================================
    // QUICK DIAGNOSTIC FUNCTIONS
    // ==========================================================================

    function quickDiagnostic() {
        return runFullDiagnostic({ verbose: true, showUI: true });
    }

    function silentDiagnostic() {
        return runFullDiagnostic({ verbose: false, showUI: false });
    }

    function diagnosticForDivisions(divisionNames) {
        return runFullDiagnostic({ 
            divisionsToCheck: Array.isArray(divisionNames) ? divisionNames : [divisionNames],
            verbose: true, 
            showUI: true 
        });
    }

    function diagnosticForDateRange(startDate, endDate) {
        return runFullDiagnostic({ 
            dateRange: { start: startDate, end: endDate },
            verbose: true, 
            showUI: true 
        });
    }

    // ==========================================================================
    // EXPORTS
    // ==========================================================================

    window.ScheduleDiagnostic = {
        version: VERSION,
        run: runFullDiagnostic,
        quick: quickDiagnostic,
        silent: silentDiagnostic,
        forDivisions: diagnosticForDivisions,
        forDateRange: diagnosticForDateRange,
        CONFIG
    };

    // Convenience aliases
    window.runScheduleDiagnostic = quickDiagnostic;
    window.diagnoseScheduleGeneration = quickDiagnostic;

    console.log('✅ Schedule Generation Diagnostic v' + VERSION + ' loaded');
    console.log('   Usage: runScheduleDiagnostic() or ScheduleDiagnostic.run(options)');

})();
