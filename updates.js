

// =================================================================
// updates.js
//
// Displays a changelog of new features and improvements.
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
                        <li><strong>🏆 League Game Results & Standings:</strong> You can now track actual game scores for both Regular and Specialty Leagues. 
                            <ul>
                                <li>Enter scores for any game.</li>
                                <li>"Import from Schedule" automatically pulls today's matchups.</li>
                                <li>Standings (Wins/Losses/Ties) are <strong>automatically calculated</strong> based on your game history.</li>
                            </ul>
                        </li>
                        <li><strong>🖨️ Print Center:</strong> Generate beautiful, printer-friendly schedules for Bunks, Divisions, or specific Fields. Found in the new "Print Center" tab.</li>
                        <li><strong>⚠️ Conflict Validator:</strong> Added a "Validate Schedule" button to the Daily Schedule view. It scans for double-bookings, missing lunches, and bunk exhaustion.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>🛡️ Saving & Backup</h3>
                    <ul>
                        <li><strong>Auto-Save System:</strong> Your work is now automatically saved every 10 minutes.</li>
                        <li><strong>"Save Now" Button:</strong> Added a manual save button in the Setup tab.</li>
                        <li><strong>Recall Auto-Save:</strong> Restore the last auto-save point if needed.</li>
                        <li><strong>New Grid:</strong> Safely start a new Master Template with a prompt to save first.</li>
                    </ul>
                </div>

                <div class="help-card">
                    <h3>📊 Analytics & Logic</h3>
                    <ul>
                        <li><strong>Bolstered Availability Grid:</strong> Stricter logic marks a field "X" if <em>anyone</em> is using it. Green checks only if 100% free.</li>
                        <li><strong>Partial Availability:</strong> Detects if a field opens up early (e.g., "Avail 12:20 PM").</li>
                        <li><strong>Smart "Super Placer":</strong> The scheduler AI now separates League history from General Activity history.</li>
                        <li><strong>Field Preferences:</strong> Set fields as "Exclusive" to specific divisions or define a Priority Order.</li>
                    </ul>
                </div>

            </div>
        </div>
    `;
}

window.initUpdatesTab = initUpdatesTab;

})();
