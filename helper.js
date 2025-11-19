// =================================================================
// helper.js
//
// Provides a "Help & Guide" tab to explain the application's features.
// - UPDATED: Added tip about left-clicking tiles for info.
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
                    <li><strong>ℹ️ Tile Info:</strong> In the Master Scheduler, <strong>Left-Click</strong> on any draggable tile (e.g., "Activity", "Sports") to see a popup explaining exactly what that tile does and how the optimizer treats it.</li>

                    <li><strong>🧠 Smart Optimizer Logic:</strong> The scheduler isn't random. It remembers what activities each bunk played yesterday and over the last 7 days. It actively tries to provide variety and avoid repeating the same sport two days in a row.</li>
                    
                    <li><strong>⚡ Priority Scheduling:</strong> "Specialty Leagues" (e.g., 5th Grade Basketball) get <strong>Priority #1</strong>. The system locks down the necessary fields for these games <em>before</em> scheduling any general activities.</li>
                    
                    <li><strong>🛡️ Auto-Save & Backup:</strong> Your work is saved automatically every 10 minutes. You can also "Export" your entire setup to a file on your computer for offline safekeeping or to transfer to another device.</li>
                    
                    <li><strong>⏱️ Precision Availability:</strong> The "Report" tab doesn't just show "Busy" or "Free". If a field is used for a short game (e.g., 20 mins), the grid will tell you exactly when it frees up (e.g., <span style="background:#fff9c4; padding:0 4px;">Avail 12:20 PM</span>).</li>
                    
                    <li><strong>📌 Strategic Pinning:</strong> Need to force a change? Use the "Bunk Specific" tab in Daily Adjustments to lock a specific bunk into a specific activity. This overrides all other rules and templates.</li>
                    
                    <li><strong>📂 Master Templates:</strong> Don't just build one schedule. Create templates for "Rainy Day", "Trip Day", or "Friday" in the Master Scheduler. You can load these instantly into any specific date.</li>
                </ul>
            </div>

            <div class="help-grid">
                
                <div class="help-card">
                    <h3>1. Setup (Bunks & Divisions)</h3>
                    <p><strong>Goal:</strong> Define who is in camp.</p>
                    <ul>
                        <li><strong>Divisions:</strong> Create groups like "5th Grade" or "Sophomores". Set a color for easy identification.</li>
                        <li><strong>Bunks:</strong> Add individual bunks (e.g., "Bunk 1", "Bunk 2") and assign them to a Division.</li>
                        <li><strong>Times:</strong> You can set specific start/end times for each division if they run on different schedules.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>2. Fields & Special Activities</h3>
                    <p><strong>Goal:</strong> Define what activities are available.</p>
                    <ul>
                        <li><strong>Fields:</strong> Create physical locations (e.g., "Basketball Court 1"). Assign which sports can be played there.</li>
                        <li><strong>Special Activities:</strong> Create non-sport activities (e.g., "Arts & Crafts", "Canteen").</li>
                        <li><strong>Rules:</strong> You can make a field "Sharable" (2 bunks at once) or set specific time restrictions (e.g., "Closed after 2 PM").</li>
                    </ul>
                </div>

                <div class="help-card highlight-card">
                    <h3>3. Master Scheduler (Templates)</h3>
                    <p><strong>Goal:</strong> Create the "Perfect Day" structure.</p>
                    <p>Use this to build templates (e.g., "Regular Monday", "Friday Short Day").</p>
                    <ul>
                        <li><strong>Drag & Drop:</strong> Drag "Activity", "Sports", or "Swim" blocks onto the grid.</li>
                        <li><strong>Generic Slots:</strong> Use "General Activity Slot" to let the AI decide the best activity later.</li>
                        <li><strong>Pins:</strong> Use "Lunch" or "Dismissal" for fixed events that never change.</li>
                    </ul>
                </div>

                <div class="help-card highlight-card">
                    <h3>4. Daily Adjustments & Optimizer</h3>
                    <p><strong>Goal:</strong> Build the schedule for <em>today</em>.</p>
                    <ol>
                        <li><strong>Load Skeleton:</strong> The system loads your Master Template for the current day of the week.</li>
                        <li><strong>Add Trips:</strong> Add one-off trips (e.g., "Museum") that override the schedule for specific divisions.</li>
                        <li><strong>Manage Resources:</strong> Close a field if it's raining or unavailable today.</li>
                        <li><strong>RUN OPTIMIZER:</strong> Click the green button to fill all "Activity Slots" with actual sports and games!</li>
                    </ol>
                </div>

                <div class="help-card">
                    <h3>5. Leagues</h3>
                    <p><strong>Goal:</strong> Manage season-long competitions.</p>
                    <ul>
                        <li><strong>Specialty Leagues:</strong> Dedicated leagues for one sport (e.g., "5th Grade Basketball League").</li>
                        <li><strong>Regular Leagues:</strong> General inter-bunk games.</li>
                        <li><strong>Standings:</strong> Track Wins, Losses, and Ties directly in the app.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>6. Report & Analytics</h3>
                    <p><strong>Goal:</strong> Ensure fairness and check availability.</p>
                    <ul>
                        <li><strong>Field Availability:</strong> See a live grid of every field. Green Check = Empty. Red X = Busy.</li>
                        <li><strong>Bunk Rotation:</strong> See how many times a bunk has played "Soccer" or had "Canteen" in the last 7 days.</li>
                    </ul>
                </div>

            </div>
        </div>
    `;
}

window.initHelperTab = initHelperTab;

})();
