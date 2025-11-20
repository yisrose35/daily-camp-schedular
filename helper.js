// =================================================================
// helper.js
//
// Provides a "Help & Guide" tab to explain the application's features.
// =================================================================

(function() {
'use strict';

function initHelperTab() {
    const container = document.getElementById("helper-content");
    if (!container) return;

    container.innerHTML = `
        <div class="help-wrapper">
            <h1 style="color: #1a5fb4; border-bottom: 2px solid #ddd; padding-bottom: 10px;">Camp Scheduler Guide</h1>
            
            <div class="help-footer" style="margin-top: 0; margin-bottom: 30px; background: #e8f5e9; border-color: #c8e6c9;">
                <h3 style="color: #2e7d32;">💡 Pro Tips & Key Features</h3>
                <ul style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px 40px;">
                    <li><strong>ℹ️ Tile Info:</strong> In the Master Scheduler, <strong>Left-Click</strong> on any draggable tile to see exactly what it does.</li>
                    <li><strong>🧠 Smart Optimizer:</strong> The scheduler remembers what activities bunks played yesterday to avoid repeats.</li>
                    <li><strong>⚡ Priority Scheduling:</strong> "Specialty Leagues" get <strong>Priority #1</strong> for fields.</li>
                    <li><strong>🛡️ Auto-Save:</strong> Work is saved every 10 minutes. Use "Export" for offline backups.</li>
                    <li><strong>⏱️ Precision Availability:</strong> The "Report" tab shows exactly when a field frees up (e.g., <span style="background:#fff9c4; padding:0 4px;">Avail 12:20 PM</span>).</li>
                    <li><strong>📌 Strategic Pinning:</strong> Use "Bunk Specific" pins in Daily Adjustments to force specific activities.</li>
                </ul>
            </div>

            <div class="help-grid">
                
                <div class="help-card">
                    <h3>1. Setup (Bunks & Divisions)</h3>
                    <p>Define who is in camp. Create Divisions (e.g., "5th Grade") and assign Bunks to them.</p>
                </div>

                <div class="help-card">
                    <h3>2. Fields & Activities</h3>
                    <p>Create locations (Fields) and non-sport activities (Specials). Use "Priority & Preferences" to restrict fields to specific divisions.</p>
                </div>

                <div class="help-card highlight-card">
                    <h3>3. Master Scheduler</h3>
                    <p>Build your "Perfect Day" templates here. Drag blocks like "Activity", "Sports", or "Swim" onto the grid. Save different templates for different days.</p>
                </div>

                <div class="help-card highlight-card">
                    <h3>4. Daily Adjustments</h3>
                    <ol>
                        <li><strong>Load Skeleton:</strong> Loads your Master Template.</li>
                        <li><strong>Add Trips:</strong> Add one-off trips.</li>
                        <li><strong>RUN OPTIMIZER:</strong> Click the green button to fill all slots with actual games!</li>
                    </ol>
                </div>

                <div class="help-card">
                    <h3>5. Leagues & Scoring</h3>
                    <p>Manage season-long competitions.</p>
                    <ul>
                        <li><strong>Standings Manager:</strong> Click "Manage Standings" in any league to enter scores.</li>
                        <li><strong>Import from Schedule:</strong> In the Game Results tab, click "Import" to automatically pull today's games from the daily schedule.</li>
                        <li><strong>Auto-Calculation:</strong> Wins, Losses, and Ties are calculated automatically from your entered scores.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>6. Reports & Print</h3>
                    <ul>
                        <li><strong>Reports:</strong> Check Field Availability and Bunk Rotation history.</li>
                        <li><strong>Print Center:</strong> Generate printable schedules for Bunks, Divisions, or Locations.</li>
                        <li><strong>Validator:</strong> Scan the schedule for double-bookings or missing lunches.</li>
                    </ul>
                </div>

            </div>
        </div>
    `;
}

window.initHelperTab = initHelperTab;

})();
