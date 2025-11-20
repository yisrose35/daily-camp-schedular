// =================================================================
// validator.js
//
// Scans the current schedule for common issues:
// 1. Field Double Bookings (Crucial)
// 2. Missing Lunch
// 3. High Exertion (3+ consecutive sports)
// =================================================================

(function() {
'use strict';

function validateSchedule() {
    const assignments = window.scheduleAssignments || {};
    const unifiedTimes = window.unifiedTimes || [];
    const app1 = window.loadGlobalSettings?.().app1 || {};
    const fields = app1.fields || [];
    
    // Prepare Field Rules Map
    const fieldRules = {};
    fields.forEach(f => {
        fieldRules[f.name] = {
            sharable: f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom',
            limit: (f.sharableWith?.type === 'all' || f.sharableWith?.type === 'custom') ? 2 : 1
        };
    });

    const errors = [];
    const warnings = [];

    // --- 1. CHECK FIELD USAGE (Double Bookings) ---
    const usageMap = {}; // slotIndex -> fieldName -> count

    Object.keys(assignments).forEach(bunk => {
        const schedule = assignments[bunk];
        if (!schedule) return;

        schedule.forEach((entry, slotIdx) => {
            if (entry && entry.field && entry.field !== "Free" && entry.field !== "No Field" && entry.field !== "No Game") {
                const fName = (typeof entry.field === 'string') ? entry.field : entry.field.name;
                
                // Initialize
                if (!usageMap[slotIdx]) usageMap[slotIdx] = {};
                if (!usageMap[slotIdx][fName]) usageMap[slotIdx][fName] = 0;

                // Increment
                usageMap[slotIdx][fName]++;
            }
        });
    });

    // Analyze Usage
    Object.keys(usageMap).forEach(slotIdx => {
        const slotUsage = usageMap[slotIdx];
        const timeLabel = unifiedTimes[slotIdx]?.label || `Slot ${slotIdx}`;

        Object.keys(slotUsage).forEach(fName => {
            const count = slotUsage[fName];
            const rules = fieldRules[fName] || { limit: 1 }; // Default to 1 if unknown
            
            if (count > rules.limit) {
                errors.push(`<strong>Double Booking:</strong> ${fName} is used by ${count} bunks at ${timeLabel} (Limit: ${rules.limit}).`);
            }
        });
    });

    // --- 2. CHECK BUNK SCHEDULES (Lunch & Exertion) ---
    Object.keys(assignments).forEach(bunk => {
        const schedule = assignments[bunk];
        let hasLunch = false;
        let consecutiveSports = 0;

        schedule.forEach(entry => {
            if (!entry) return;
            
            const actName = (typeof entry.field === 'string') ? entry.field : entry.field.name;
            
            // Check Lunch
            if (actName.toLowerCase().includes('lunch')) hasLunch = true;

            // Check Exertion (Is it a sport?)
            // We assume if it has a 'sport' property or is in the fields list, it's a sport
            const isSport = !!entry.sport || fields.some(f => f.name === actName && f.activities?.length > 0);

            if (isSport) {
                consecutiveSports++;
            } else {
                if (consecutiveSports >= 3) {
                    warnings.push(`<strong>High Exertion:</strong> ${bunk} has ${consecutiveSports} sports in a row ending near ${(unifiedTimes[schedule.indexOf(entry)-1]?.label || "")}.`);
                }
                consecutiveSports = 0;
            }
        });

        // Final check for end of day
        if (consecutiveSports >= 3) {
            warnings.push(`<strong>High Exertion:</strong> ${bunk} has ${consecutiveSports} sports in a row at the end of the day.`);
        }

        if (!hasLunch) {
            warnings.push(`<strong>Missing Lunch:</strong> ${bunk} has no "Lunch" scheduled.`);
        }
    });

    // --- DISPLAY RESULTS ---
    showValidationModal(errors, warnings);
}

function showValidationModal(errors, warnings) {
    // Remove existing if any
    const existing = document.getElementById('validator-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'validator-modal';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 2000;
        display: flex; justify-content: center; align-items: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background: white; padding: 20px; border-radius: 8px;
        width: 500px; max-height: 80vh; overflow-y: auto;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3); font-family: Arial, sans-serif;
    `;

    let html = `<h2 style="margin-top:0; border-bottom:1px solid #eee; padding-bottom:10px;">Schedule Validation</h2>`;

    if (errors.length === 0 && warnings.length === 0) {
        html += `<div style="text-align:center; padding: 20px; color: green;">
            <h3 style="margin:0;">✅ All Good!</h3>
            <p>No conflicts or warnings found.</p>
        </div>`;
    } else {
        if (errors.length > 0) {
            html += `<h4 style="color:#d32f2f; margin-bottom:5px;">❌ Critical Conflicts (${errors.length})</h4>
            <ul style="color:#d32f2f; background:#ffebee; padding:10px 20px; border-radius:5px; margin-top:0;">
                ${errors.map(e => `<li>${e}</li>`).join('')}
            </ul>`;
        }
        if (warnings.length > 0) {
            html += `<h4 style="color:#f57c00; margin-bottom:5px;">⚠️ Warnings (${warnings.length})</h4>
            <ul style="color:#e65100; background:#fff3e0; padding:10px 20px; border-radius:5px; margin-top:0;">
                ${warnings.map(w => `<li>${w}</li>`).join('')}
            </ul>`;
        }
    }

    html += `<div style="text-align:right; margin-top:15px;">
        <button id="close-validator" style="padding:8px 16px; background:#333; color:white; border:none; border-radius:4px; cursor:pointer;">Close</button>
    </div>`;

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.getElementById('close-validator').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

window.validateSchedule = validateSchedule;

})();
