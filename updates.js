// =================================================================
// updates.js
//
// Displays a changelog of new features and improvements.
// Uses the same CSS classes as helper.js for consistency.
// =================================================================

(function() {
'use strict';

function initUpdatesTab() {
    const container = document.getElementById("updates-content");
    if (!container) return;

    container.innerHTML = `
        <div class="help-wrapper">
            <h1 style="color: #1a5fb4; border-bottom: 2px solid #ddd; padding-bottom: 10px;">What's New</h1>
            
            <div class="help-grid">
                
                <div class="help-card highlight-card">
                    <h3>🚀 Latest Features</h3>
                    <ul>
                        <li><strong>Auto-Save System:</strong> Your work is now automatically saved every 10 minutes to prevent data loss.</li>
                        <li><strong>"Save Now" Button:</strong> Added a manual save button in the Setup tab for peace of mind.</li>
                        <li><strong>Recall Auto-Save:</strong> Accidentally messed up? You can now restore the last auto-save point.</li>
                        <li><strong>Precise Availability:</strong> The Analytics grid now detects partial availability (e.g., "Avail 12:20 PM") if a scheduled block ends early.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>📊 Reports & Analytics</h3>
                    <ul>
                        <li><strong>Bolstered Availability Grid:</strong> Stricter logic now marks a field with a red <strong>X</strong> if <em>anyone</em> is using it (League, Pin, or Activity). Green checks only appear if 100% free.</li>
                        <li><strong>"Scheduled Today?" Column:</strong> The Bunk Rotation report now highlights if a bunk is already scheduled for an activity today (Green "YES").</li>
                        <li><strong>Smart Filters:</strong> Filter the availability grid by "Fields Only" or "Specials Only".</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>🗓️ Master Scheduler</h3>
                    <ul>
                        <li><strong>Clear Grid Button:</strong> Safely wipe the grid to build a new template (e.g., Short Day) without deleting your saved templates.</li>
                        <li><strong>Draft Saving:</strong> The editor now saves a local draft, so if you accidentally close the tab, your unsaved grid is waiting for you when you return.</li>
                        <li><strong>Visual Cues:</strong> The "Load Template" area highlights after clearing to remind you of your options.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>🏆 Leagues & Specialty Leagues</h3>
                    <ul>
                        <li><strong>Standings Manager:</strong> Track Wins, Losses, and Ties directly inside the League Editor.</li>
                        <li><strong>UI Overhaul:</strong> Leagues now use a modern, card-based interface with dedicated editors.</li>
                        <li><strong>Priority Scheduling:</strong> Specialty Leagues now have Priority #1 for fields during auto-scheduling.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>⚡ Daily Adjustments</h3>
                    <ul>
                        <li><strong>Bunk Specific Overrides:</strong> You can now pin a specific activity for a specific bunk at a specific time (overriding the skeleton).</li>
                        <li><strong>New Interface:</strong> Organized into sub-tabs (Skeleton, Trips, Bunk Specific, Resources) for a cleaner workflow.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>🛠️ General Improvements</h3>
                    <ul>
                        <li><strong>Backup & Restore:</strong> Export your entire database to a JSON file for offline backup. Import it on any computer to restore your work.</li>
                        <li><strong>Welcome Screen:</strong> A new setup wizard for first-time users.</li>
                        <li><strong>Smart "Super Placer":</strong> The scheduler's AI now separates League history from General Activity history to ensure better variety.</li>
                    </ul>
                </div>

            </div>
        </div>
    `;
}

window.initUpdatesTab = initUpdatesTab;

})();
