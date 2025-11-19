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
                        <li><strong>Specialty Leagues:</strong> Dedicated leagues for one sport (e.g., "5th Grade Basketball League"). These get <strong>Priority #1</strong> for fields.</li>
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

            <div class="help-footer">
                <h3>💡 Pro Tips</h3>
                <ul>
                    <li><strong>The Optimizer is Smart:</strong> It looks at what bunks did yesterday and over the last week to avoid repeating activities.</li>
                    <li><strong>Auto-Save & Manual Save:</strong> Your work is automatically saved every 10 minutes. You can also use the "Save Now" button in the Setup tab to save immediately at any time.</li>
                    <li><strong>Backup & Offline:</strong> Use the "Export" button in the Setup tab to save a file to your computer. This allows you to keep offline backups or transfer your work. You can "Import" this file later to restore everything.</li>
                    <li><strong>Availability Grid:</strong> If you need to squeeze in a last-minute game, check the "Report" tab's Availability Grid to find a free 30-minute slot.</li>
                    <li><strong>Locking Activities:</strong> In "Daily Adjustments", you can add "Bunk Specific" pins to force a specific bunk to do a specific activity at a specific time.</li>
                </ul>
            </div>
        </div>
    `;
}

window.initHelperTab = initHelperTab;

})();
